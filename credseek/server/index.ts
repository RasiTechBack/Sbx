import cors from 'cors'
import express from 'express'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProdSecrets, config } from './config.js'
import { canManageData, parseCredentialLine, type Role, type User } from './store.js'
import {
  adoptExternalImportTotal,
  dedupeDatabase,
  ensureDedupeIndex,
  EXCEL_EXPORT_CAP,
  getEnrichmentByUrls,
  getIpv4ByDomains,
  initRecordsDb,
  iterateSearch,
  iterateSearchExportLines,
  MAX_SEARCH_OFFSET,
  migrateJsonToSqliteIfNeeded,
  runMaintenance,
  validateSearchQuery,
  warmDashboardStats,
  type SearchFilter,
} from './db/recordsDb.js'
import {
  enrichmentStatusSnapshot,
  startEnrichmentWorker,
} from './enrichment/worker.js'
import {
  assertImportsAllowed,
  getDbStorageGuard,
  setMaxDbBytes,
  setMaxDbGb,
} from './storageGuard.js'
import { initPostgres, hasPostgres } from './db/postgres.js'
import {
  clearAllRecordsUnified,
  getDashboardStatsUnified,
  getRecordsCountUnified,
  getRecordsDbSizeBytesUnified,
  initSearchBackend,
  insertCredentialsUnified,
  iterateSearchUnified,
  searchBackend,
  searchRecordsUnified,
} from './search/backend.js'
import {
  countAdmins,
  countUsers,
  countUsersByRole,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  listUsersPaged,
  migrateUsersJsonToPostgres,
  updateUser,
} from './users/repo.js'
import { rateLimitMiddleware } from './middleware/rateLimit.js'
import { isCompanyEmail } from './registrations/companyEmail.js'
import {
  createRegistrationRequest,
  findRegistrationByEmail,
  findRegistrationById,
  listRegistrationRequests,
  publicRegistration,
  updateRegistrationRequest,
} from './registrations/store.js'
import { sendMail } from './mail/sendMail.js'
import {
  createImportJob,
  listImportJobs,
  enqueueExistingJob,
  getImportJob,
  patchImportJob,
  stagingPath,
} from './jobs/importJobs.js'
import { startImportJobRunner } from './jobs/importRunner.js'
import { parseImportFile, SUPPORTED_EXTENSIONS } from './importers/parseFile.js'
import type { ImportProgressEvent } from './importers/progress.js'
import { enqueueIsolatedImport, runIsolatedFileImport } from './importers/runIsolatedImport.js'
import { capturePreview, closePreviewBrowser } from './preview/capture.js'
import { resolvePreviewImagePath, readPreviewMeta, ensurePreviewDir } from './preview/store.js'
import { getGuardSample, startRuntimeGuard } from './guard/runtimeGuard.js'
import {
  aggregateDomainsFromSearch,
  aggregatePicturesFromSearch,
  listRecordsForUrl,
} from './preview/searchViews.js'
import { createTtlCache } from './util/ttlCache.js'

/** Hot search responses (credentials / domains / pictures) — cuts repeat UI tab cost. */
const searchResultCache = createTtlCache<unknown>({ maxEntries: 280, defaultTtlMs: 60_000 })
const searchAggCache = createTtlCache<unknown>({ maxEntries: 200, defaultTtlMs: 90_000 })
const enrichmentStatusCache = createTtlCache<unknown>({ maxEntries: 8, defaultTtlMs: 15_000 })
import {
  importFromRemoteUrl,
  readTelegramConfig,
  writeTelegramConfig,
} from './importers/fetchRemote.js'
import {
  confirmTelegramCode,
  confirmTelegramPassword,
  importTelegramSessionFile,
  importTelegramStringSession,
  listLinkedTelegramAccounts,
  startTelegramLogin,
  testAllTelegramAccounts,
  testTelegramAccount,
  unlinkTelegram,
} from './telegram/auth.js'
import {
  createMonitorDraft,
  getMonitor,
  patchMonitor,
  readMonitors,
  removeMonitor,
  upsertMonitor,
} from './telegram/monitors.js'
import {
  backfillMonitor,
  ensureLiveWatcher,
  pauseInterruptedBackfillsOnStartup,
  listAccountDialogs,
  resolveAndAttachMonitor,
  stopBotClient,
  testBotConnection,
} from './telegram/botMonitor.js'
import {
  mountSubscriptionRoutes,
  startPaymentPoller,
} from './subscription/routes.js'
import {
  publicSubscription,
  userHasActiveAccess,
} from './subscription/store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = config.port
const HOST = config.host
const JWT_SECRET = config.jwtSecret
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024, files: 30 },
})
const uploadDisk = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(config.importStagingDir, { recursive: true })
      cb(null, config.importStagingDir)
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}__${file.originalname.replace(/[^a-zA-Z0-9._-]+/g, '_')}`)
    },
  }),
  limits: { fileSize: 120 * 1024 * 1024, files: 30 },
})
const distDir = path.resolve(__dirname, '../dist')

const corsOrigin =
  config.corsOrigin === '*'
    ? true
    : config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean)

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
)
app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.resolve(__dirname, '../public'), { index: false, fallthrough: true }))

type AuthRequest = express.Request & { user?: User }

function isSubscriptionExemptApi(pathname: string) {
  // When used inside `app.use('/api', ...)`, Express strips the `/api` prefix from req.path.
  const p = pathname.startsWith('/api/') ? pathname.slice(4) : pathname
  const path = p.startsWith('/') ? p : `/${p}`
  return (
    path === '/health' ||
    path.startsWith('/auth/') ||
    path.startsWith('/subscription/') ||
    path.startsWith('/admin/') ||
    path.startsWith('/registrations') ||
    path.startsWith('/users')
  )
}

async function authMiddleware(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string }
    const user = await findUserById(payload.id)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

/** Attach user if token valid; continue as guest otherwise. */
async function optionalAuth(req: AuthRequest, _res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    next()
    return
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string }
    req.user = (await findUserById(payload.id)) || undefined
  } catch {
    // guest
  }
  next()
}

/** Logged-in members without an active plan cannot use product APIs. Guests stay allowed (masked). */
app.use('/api', async (req: AuthRequest, res, next) => {
  try {
    if (isSubscriptionExemptApi(req.path)) return next()
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return next()
    if (!req.user) {
      try {
        const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string }
        req.user = (await findUserById(payload.id)) || undefined
      } catch {
        return next()
      }
    }
    if (req.user && !userHasActiveAccess(req.user)) {
      return res.status(402).json({
        error: 'Langganan belum aktif. Pilih paket & bayar QRIS di /subscribe',
        code: 'SUBSCRIPTION_REQUIRED',
        subscription: publicSubscription(req.user),
        checkoutPath: '/subscribe',
      })
    }
    next()
  } catch (err) {
    next(err)
  }
})

const GUEST_RESULT_CAP = 150

function maskMiddle(value: string, keepStart = 2, keepEnd = 1) {
  if (!value) return value
  if (value.length <= keepStart + keepEnd) return '*'.repeat(Math.max(value.length, 3))
  return `${value.slice(0, keepStart)}${'*'.repeat(Math.min(8, value.length - keepStart - keepEnd))}${value.slice(-keepEnd)}`
}

function maskUrl(url: string) {
  try {
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url)
      const host = maskMiddle(u.host, 3, 2)
      const path = u.pathname.length > 1 ? `/${'*'.repeat(Math.min(6, u.pathname.length))}` : ''
      return `${u.protocol}//${host}${path}`
    }
  } catch {
    // fall through
  }
  return maskMiddle(url, 4, 2)
}

function maskRecord(r: {
  id: string
  isi: string
  database: string
  url: string
  username: string
  password: string
  raw: string
  pageTitle?: string
  pageDescription?: string
  pageIps?: string[]
}) {
  const url = maskUrl(r.url)
  const username = maskMiddle(r.username, 2, 1)
  const password = maskMiddle(r.password, 1, 1)
  return {
    id: r.id,
    isi: r.isi,
    database: r.database,
    url,
    username,
    password,
    raw: `${url}:${username}:${password}`,
    pageTitle: r.pageTitle,
    pageDescription: r.pageDescription,
    pageIps: r.pageIps,
  }
}

function requireDataManager(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  if (!canManageData(req.user?.role)) {
    return res.status(403).json({ error: 'Hanya admin atau dev yang bisa menambah/mengelola data' })
  }
  next()
}

/** Block new imports when SQLite on-disk size hits the configured ceiling. */
function requireImportCapacity(_req: AuthRequest, res: express.Response, next: express.NextFunction) {
  try {
    assertImportsAllowed()
    next()
  } catch (err) {
    const guard = getDbStorageGuard()
    const message = err instanceof Error ? err.message : guard.message
    return res.status(507).json({
      error: message,
      code: 'IMPORT_PAUSED',
      storage: guard,
    })
  }
}

function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatarColor: user.avatarColor,
    createdAt: user.createdAt,
    subscription: publicSubscription(user),
  }
}

app.post(
  '/api/auth/register',
  rateLimitMiddleware({ name: 'register', limit: 8, windowSec: 3600 }),
  async (req, res) => {
    const {
      contactName,
      name,
      workEmail,
      email,
      password,
      companyName,
      companyWebsite,
      jobTitle,
      phone,
      companySize,
      useCase,
      inviteCode,
      website,
    } = req.body as {
      contactName?: string
      name?: string
      workEmail?: string
      email?: string
      password?: string
      companyName?: string
      companyWebsite?: string
      jobTitle?: string
      phone?: string
      companySize?: string
      useCase?: string
      inviteCode?: string
      website?: string
    }

    // Honeypot — bots fill hidden fields
    if (website) return res.status(201).json({ ok: true, pending: true })

    if (config.inviteOnlyRegister) {
      if (!inviteCode || inviteCode !== config.registerInviteCode) {
        return res.status(403).json({ error: 'Registrasi membutuhkan kode undangan valid' })
      }
    }

    const contact = (contactName || name || '').trim()
    const work = (workEmail || email || '').trim().toLowerCase()
    const company = (companyName || '').trim()
    const companyWeb = (companyWebsite || '').trim()
    const title = (jobTitle || '').trim()
    const phoneVal = (phone || '').trim()
    const size = (companySize || '').trim()
    const notes = (useCase || '').trim()

    if (!contact || !work || !password || password.length < 6) {
      return res.status(400).json({
        error: 'Nama kontak, email perusahaan, dan password (min 6) wajib diisi',
      })
    }
    if (!company) {
      return res.status(400).json({ error: 'Nama perusahaan wajib diisi' })
    }

    const emailCheck = isCompanyEmail(work)
    if (!emailCheck.ok) {
      return res.status(400).json({ error: emailCheck.error })
    }

    if (await findUserByEmail(work)) {
      return res.status(409).json({ error: 'Email sudah terdaftar' })
    }

    const existingReq = findRegistrationByEmail(work)
    if (existingReq && existingReq.status === 'pending') {
      return res.status(409).json({
        error: 'Pengajuan untuk email ini sudah masuk antrian verifikasi RasiTech',
        pending: true,
        requestId: existingReq.id,
      })
    }
    if (existingReq && existingReq.status === 'approved') {
      return res.status(409).json({ error: 'Email sudah terdaftar — silakan masuk' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const row = createRegistrationRequest({
      contactName: contact,
      workEmail: work,
      companyName: company,
      companyWebsite: companyWeb,
      jobTitle: title,
      phone: phoneVal,
      companySize: size,
      useCase: notes,
      passwordHash,
      mailSent: false,
    })

    // User sends the email themselves via mailto (no server SMTP).
    const supportTo = config.supportEmail
    const subject = `[CredSeek] Company signup — ${company}`
    const body = [
      'Halo RasiTech Support,',
      '',
      'Saya ingin mendaftarkan akun CredSeek untuk perusahaan kami.',
      '',
      `Request ID : ${row.id}`,
      `Kontak     : ${contact}`,
      `Email kerja: ${work}`,
      `Perusahaan : ${company}`,
      `Website    : ${companyWeb || '-'}`,
      `Jabatan    : ${title || '-'}`,
      `Telepon    : ${phoneVal || '-'}`,
      `Ukuran     : ${size || '-'}`,
      `Kebutuhan  : ${notes || '-'}`,
      '',
      'Mohon diverifikasi. Saya sudah membuat password di form CredSeek.',
      'Terima kasih.',
    ].join('\n')
    const mailtoUrl =
      `mailto:${supportTo}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`

    res.status(202).json({
      ok: true,
      pending: true,
      requestId: row.id,
      supportEmail: supportTo,
      mailtoUrl,
      message:
        'Pengajuan tersimpan. Lanjutkan dengan mengirim email dari aplikasi email Anda ke support@rasitech.org — akun aktif setelah RasiTech menyetujui.',
    })
  },
)

app.get('/api/registrations', authMiddleware, requireAdmin, (req: AuthRequest, res) => {
  const statusRaw = String(req.query.status || 'pending').toLowerCase()
  const status =
    statusRaw === 'all'
      ? undefined
      : statusRaw === 'approved' || statusRaw === 'rejected' || statusRaw === 'pending'
        ? statusRaw
        : 'pending'
  const rows = listRegistrationRequests(status).map(publicRegistration)
  res.json({ requests: rows, total: rows.length })
})

app.post(
  '/api/registrations/:id/approve',
  authMiddleware,
  requireAdmin,
  async (req: AuthRequest, res) => {
    const row = findRegistrationById(req.params.id)
    if (!row) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' })
    if (row.status === 'approved' && row.userId) {
      return res.json({ ok: true, already: true, request: publicRegistration(row) })
    }
    if (row.status === 'rejected') {
      return res.status(400).json({ error: 'Pengajuan sudah ditolak' })
    }
    if (await findUserByEmail(row.workEmail)) {
      const updated = updateRegistrationRequest(row.id, {
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: req.user!.email,
      })
      return res.status(409).json({
        error: 'Email sudah punya akun — tandai approved',
        request: updated ? publicRegistration(updated) : null,
      })
    }

    try {
      const user = await createUser({
        name: row.contactName,
        email: row.workEmail,
        passwordHash: row.passwordHash,
        role: 'user',
      })
      const updated = updateRegistrationRequest(row.id, {
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: req.user!.email,
        userId: user.id,
      })
      void sendMail({
        to: row.workEmail,
        subject: 'CredSeek account approved',
        text: [
          `Halo ${row.contactName},`,
          '',
          `Pengajuan akun CredSeek untuk ${row.companyName} telah disetujui oleh RasiTech.`,
          'Silakan masuk dengan email perusahaan dan password yang Anda buat saat mendaftar.',
          '',
          `Login: ${req.protocol}://${req.get('host') || '202.10.34.119'}/login`,
          '',
          '— CredSeek / RasiTech',
        ].join('\n'),
      })
      res.json({ ok: true, user: publicUser(user), request: updated ? publicRegistration(updated) : null })
    } catch (err) {
      if (err instanceof Error && (err.message === 'EMAIL_TAKEN' || /unique/i.test(err.message))) {
        return res.status(409).json({ error: 'Email sudah terdaftar' })
      }
      throw err
    }
  },
)

app.post(
  '/api/registrations/:id/reject',
  authMiddleware,
  requireAdmin,
  async (req: AuthRequest, res) => {
    const row = findRegistrationById(req.params.id)
    if (!row) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' })
    if (row.status === 'approved') {
      return res.status(400).json({ error: 'Pengajuan sudah disetujui' })
    }
    const reason = String((req.body as { reason?: string })?.reason || '').trim()
    const updated = updateRegistrationRequest(row.id, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewedBy: req.user!.email,
      rejectReason: reason || 'Tidak memenuhi kriteria verifikasi perusahaan',
    })
    void sendMail({
      to: row.workEmail,
      subject: 'CredSeek registration update',
      text: [
        `Halo ${row.contactName},`,
        '',
        `Pengajuan akun CredSeek untuk ${row.companyName} belum dapat disetujui.`,
        reason ? `Alasan: ${reason}` : '',
        '',
        'Hubungi support@rasitech.org jika Anda ingin mengklarifikasi.',
        '',
        '— CredSeek / RasiTech',
      ]
        .filter(Boolean)
        .join('\n'),
    })
    res.json({ ok: true, request: updated ? publicRegistration(updated) : null })
  },
)

app.post(
  '/api/auth/login',
  rateLimitMiddleware({ name: 'login', limit: 30, windowSec: 300 }),
  async (req, res) => {
    const { email, password, rememberMe } = req.body as {
      email?: string
      password?: string
      rememberMe?: boolean
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi' })
    }

    const user = await findUserByEmail(email)
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Email atau password salah' })
    }

    const expiresIn = rememberMe ? '30d' : '1d'
    const token = jwt.sign({ id: user.id, rememberMe: !!rememberMe }, JWT_SECRET, { expiresIn })
    res.json({
      token,
      user: publicUser(user),
      expiresIn,
      rememberMe: !!rememberMe,
    })
  },
)

app.get('/api/auth/me', authMiddleware, (req: AuthRequest, res) => {
  res.json({ user: publicUser(req.user!) })
})

app.put('/api/auth/profile', authMiddleware, async (req: AuthRequest, res) => {
  const { name, email, password, currentPassword } = req.body as {
    name?: string
    email?: string
    password?: string
    currentPassword?: string
  }

  const user = await findUserById(req.user!.id)
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

  if (name?.trim()) user.name = name.trim()

  if (email?.trim() && email.trim().toLowerCase() !== user.email) {
    const taken = await findUserByEmail(email)
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: 'Email sudah dipakai' })
    }
    user.email = email.trim().toLowerCase()
  }

  if (password) {
    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(400).json({ error: 'Password saat ini salah' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password baru minimal 6 karakter' })
    }
    user.passwordHash = await bcrypt.hash(password, 10)
  }

  await updateUser(user)
  res.json({ user: publicUser(user) })
})

app.get('/api/users', authMiddleware, async (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang bisa melihat daftar user' })
  }
  const q = String(req.query.q ?? '')
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
  const result = await listUsersPaged({ q, page, limit })
  res.json({
    users: result.users.map((u) => managedUserPublic(u)),
    total: result.total,
    page: result.page,
    limit: result.limit,
    hasMore: result.hasMore,
  })
})

function requireAdmin(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  if (req.user!.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang bisa mengelola akun' })
  }
  next()
}

function managedUserPublic(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    subscription: publicSubscription(user),
  }
}

mountSubscriptionRoutes(app, {
  authMiddleware,
  requireAdmin: (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Hanya admin yang bisa mengelola akun' })
    }
    next()
  },
  publicUser,
  bcryptHash: (password, rounds) => bcrypt.hash(password, rounds),
})

app.post('/api/users', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  const { name, email, password, role, trialDays, planId, note } = req.body as {
    name?: string
    email?: string
    password?: string
    role?: Role
    trialDays?: number
    planId?: string
    note?: string
  }

  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: 'Nama, email, dan password (min 6) wajib diisi' })
  }

  const nextRole: Role =
    role === 'admin' || role === 'dev' || role === 'user' ? role : 'user'

  if (await findUserByEmail(email)) {
    return res.status(409).json({ error: 'Email sudah terdaftar' })
  }

  try {
    const user = await createUser({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: nextRole,
    })
    let subscription = publicSubscription(user)
    if (nextRole === 'user' && Number(trialDays) > 0) {
      const { activatePlanForUser } = await import('./subscription/store.js')
      const { getPlan, listPlans } = await import('./subscription/packages.js')
      const plan = getPlan(String(planId || 'starter')) || listPlans()[0]!
      activatePlanForUser({
        userId: user.id,
        plan,
        source: 'trial',
        trial: true,
        days: Math.max(1, Number(trialDays)),
        note: note || 'Trial via user management',
      })
      subscription = publicSubscription(user)
    }
    res.status(201).json({ user: { ...managedUserPublic(user), subscription } })
  } catch (err) {
    if (err instanceof Error && /unique|EMAIL_TAKEN/i.test(err.message)) {
      return res.status(409).json({ error: 'Email sudah terdaftar' })
    }
    throw err
  }
})

app.patch('/api/users/:id/role', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  const role = (req.body as { role?: Role }).role
  if (role !== 'dev' && role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: 'Role tidak valid' })
  }

  const user = await findUserById(String(req.params.id))
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

  if (user.role === 'admin' && role !== 'admin') {
    if ((await countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir' })
    }
  }

  user.role = role
  await updateUser(user)
  res.json({ user: managedUserPublic(user) })
})

app.post('/api/users/:id/password', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  const password = String((req.body as { password?: string }).password || '')
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' })
  }

  const user = await findUserById(String(req.params.id))
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

  user.passwordHash = await bcrypt.hash(password, 10)
  await updateUser(user)
  res.json({ ok: true, user: managedUserPublic(user) })
})

app.delete('/api/users/:id', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  const user = await findUserById(String(req.params.id))
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

  if (user.id === req.user!.id) {
    return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' })
  }

  if (user.role === 'admin' && (await countAdmins()) <= 1) {
    return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir' })
  }

  const removed = await deleteUser(user.id)
  res.json({ ok: true, user: managedUserPublic(removed!) })
})

app.get(
  '/api/search',
  optionalAuth,
  rateLimitMiddleware({ name: 'search', limit: 120, windowSec: 60 }),
  async (req: AuthRequest, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const filterRaw = String(req.query.filter ?? 'all').toLowerCase()
  const filter = (
    ['all', 'url', 'username', 'password', 'domain'].includes(filterRaw) ? filterRaw : 'all'
  ) as SearchFilter
  const page = Math.max(1, Number(req.query.page) || 1)
  const isGuest = !req.user
  // Default 25 (was 100) — UI pagination still allows up to 100 when asked.
  const limit = Math.min(isGuest ? 10 : 100, Math.max(1, Number(req.query.limit) || (isGuest ? 10 : 25)))

  if (!q) {
    return res.json({
      results: [],
      total: 0,
      matchedTotal: 0,
      page,
      limit,
      filter,
      tookMs: 0,
      guest: isGuest,
      masked: isGuest,
      capped: false,
      hasMore: false,
      exportEnabled: !isGuest,
    })
  }

  const validated = validateSearchQuery(q)
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error })
  }

  const started = Date.now()
  const maxPage = Math.max(1, Math.floor(MAX_SEARCH_OFFSET / limit) + 1)
  let safePage = Math.min(page, maxPage)
  const offset = (safePage - 1) * limit
  const cacheKey = `s:${isGuest ? 'g' : 'u'}:${filter}:${limit}:${safePage}:${q}`
  const cached = searchResultCache.get(cacheKey) as Record<string, unknown> | undefined
  if (cached) {
    return res.json({ ...cached, tookMs: Date.now() - started, cached: true })
  }
  const searched = await searchRecordsUnified({
    q,
    filter,
    limit,
    offset,
  })
  if (searched.error) {
    return res.status(400).json({ error: searched.error })
  }

  const matchedTotal = searched.total
  let pageRows = searched.rows
  const hasMore = Boolean(searched.hasMore)
  const capped = isGuest && matchedTotal > GUEST_RESULT_CAP
  const total = capped ? GUEST_RESULT_CAP : matchedTotal
  if (matchedTotal > 0) {
    const totalPages = Math.max(1, Math.ceil(total / limit))
    if (safePage > totalPages && !hasMore) {
      safePage = totalPages
      pageRows = (
        await searchRecordsUnified({
          q,
          filter,
          limit,
          offset: (safePage - 1) * limit,
        })
      ).rows
    }
  }

  const enrichMap =
    searchBackend() === 'sqlite' ? getEnrichmentByUrls(pageRows.map((r) => r.url)) : new Map()
  const domainList =
    searchBackend() === 'sqlite'
      ? [
          ...new Set(
            pageRows
              .map((r) => {
                try {
                  return new URL(r.url.includes('://') ? r.url : `http://${r.url}`).hostname
                    .toLowerCase()
                    .replace(/^www\./, '')
                } catch {
                  return ''
                }
              })
              .filter(Boolean),
          ),
        ]
      : []
  const ipMap = domainList.length ? getIpv4ByDomains(domainList) : new Map<string, string[]>()

  const pageItems = pageRows.map((r) => {
    const meta = enrichMap.get(r.url)
    let domainLc = ''
    try {
      domainLc = new URL(r.url.includes('://') ? r.url : `http://${r.url}`).hostname
        .toLowerCase()
        .replace(/^www\./, '')
    } catch {
      domainLc = ''
    }
    const ips = domainLc ? ipMap.get(domainLc) : undefined
    return {
      id: r.id,
      isi: r.isi,
      database: r.database,
      url: r.url,
      username: r.username,
      password: r.password,
      raw: r.raw,
      pageTitle: meta?.title || undefined,
      pageDescription: meta?.description || undefined,
      pageIps: ips?.length ? ips : undefined,
    }
  })

  const results = isGuest ? pageItems.map(maskRecord) : pageItems

  const payload = {
    results,
    total,
    matchedTotal,
    page: safePage,
    limit,
    filter,
    tookMs: Date.now() - started,
    guest: isGuest,
    masked: isGuest,
    capped,
    hasMore,
    guestCap: GUEST_RESULT_CAP,
    exportEnabled: !isGuest,
    maxOffset: MAX_SEARCH_OFFSET,
    enrichment: searchBackend() === 'sqlite' ? enrichmentStatusSnapshot() : undefined,
  }
  searchResultCache.set(`s:${isGuest ? 'g' : 'u'}:${filter}:${limit}:${safePage}:${q}`, payload)
  res.json(payload)
})

app.get(
  '/api/search/domains',
  optionalAuth,
  rateLimitMiddleware({ name: 'search-domains', limit: 60, windowSec: 60 }),
  async (req: AuthRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Login diperlukan untuk tab Domain' })
    }
    const q = String(req.query.q ?? '').trim().toLowerCase()
    const filterRaw = String(req.query.filter ?? 'all').toLowerCase()
    const filter = (
      ['all', 'url', 'username', 'password', 'domain'].includes(filterRaw) ? filterRaw : 'all'
    ) as SearchFilter
    if (!q) return res.json({ domains: [], sampled: 0 })
    const validated = validateSearchQuery(q)
    if (!validated.ok) return res.status(400).json({ error: validated.error })
    try {
      const key = `d:${filter}:${q}`
      const hit = searchAggCache.get(key)
      if (hit) return res.json(hit)
      const out = await aggregateDomainsFromSearch(q, filter)
      searchAggCache.set(key, out)
      res.json(out)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal agregasi domain' })
    }
  },
)

app.get(
  '/api/search/pictures',
  optionalAuth,
  rateLimitMiddleware({ name: 'search-pictures', limit: 40, windowSec: 60 }),
  async (req: AuthRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Login diperlukan untuk tab Picture' })
    }
    const q = String(req.query.q ?? '').trim().toLowerCase()
    const filterRaw = String(req.query.filter ?? 'all').toLowerCase()
    const filter = (
      ['all', 'url', 'username', 'password', 'domain'].includes(filterRaw) ? filterRaw : 'all'
    ) as SearchFilter
    if (!q) return res.json({ pictures: [], sampled: 0 })
    const validated = validateSearchQuery(q)
    if (!validated.ok) return res.status(400).json({ error: validated.error })
    try {
      const key = `p:${filter}:${q}`
      const hit = searchAggCache.get(key)
      if (hit) return res.json(hit)
      const out = await aggregatePicturesFromSearch(q, filter, { capture: false })
      searchAggCache.set(key, out)
      res.json(out)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal agregasi picture' })
    }
  },
)

app.get(
  '/api/search/by-url',
  optionalAuth,
  rateLimitMiddleware({ name: 'search-by-url', limit: 60, windowSec: 60 }),
  async (req: AuthRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Login diperlukan' })
    }
    const q = String(req.query.q ?? '').trim().toLowerCase()
    const url = String(req.query.url ?? '').trim()
    const filterRaw = String(req.query.filter ?? 'all').toLowerCase()
    const filter = (
      ['all', 'url', 'username', 'password', 'domain'].includes(filterRaw) ? filterRaw : 'all'
    ) as SearchFilter
    if (!q || !url) return res.status(400).json({ error: 'q dan url wajib' })
    const validated = validateSearchQuery(q)
    if (!validated.ok) return res.status(400).json({ error: validated.error })
    const isGuest = !req.user
    try {
      const rows = await listRecordsForUrl(q, filter, url, isGuest ? 30 : 100)
      const results = rows.map((r) => {
        const full = {
          id: r.id,
          isi: '',
          database: '',
          url: r.url,
          username: r.username,
          password: r.password,
          raw: `${r.url}:${r.username}:${r.password}`,
        }
        return isGuest ? maskRecord(full) : full
      })
      res.json({ url, results, total: results.length, masked: isGuest })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal load by-url' })
    }
  },
)

app.get(
  '/api/preview/image/:hash',
  optionalAuth,
  rateLimitMiddleware({ name: 'preview-image', limit: 240, windowSec: 60 }),
  (req, res) => {
    ensurePreviewDir()
    const hash = String(req.params.hash || '').replace(/[^a-f0-9]/gi, '')
    if (hash.length < 16) return res.status(400).json({ error: 'hash invalid' })
    const meta = readPreviewMeta(hash)
    if (!meta) return res.status(404).json({ error: 'preview belum ada' })
    const img = resolvePreviewImagePath(meta)
    if (!img) return res.status(404).json({ error: 'file preview hilang' })
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.type(meta.contentType || 'image/svg+xml')
    res.sendFile(img)
  },
)

app.get(
  '/api/preview/for',
  optionalAuth,
  rateLimitMiddleware({ name: 'preview-for', limit: 90, windowSec: 60 }),
  async (req: AuthRequest, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Login diperlukan untuk preview' })
    }
    const url = String(req.query.url || '').trim()
    if (!url) return res.status(400).json({ error: 'url wajib' })
    try {
      const meta = await capturePreview(url)
      const img = resolvePreviewImagePath(meta)
      if (!img) return res.status(500).json({ error: 'gagal simpan preview' })
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('X-Preview-Status', meta.status)
      res.setHeader('X-Preview-Title', encodeURIComponent(meta.title))
      res.type(meta.contentType || 'image/svg+xml')
      res.sendFile(img)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Capture gagal' })
    }
  },
)

app.get(
  '/api/export',
  authMiddleware,
  rateLimitMiddleware({ name: 'export', limit: 20, windowSec: 3600, byUser: true }),
  async (req: AuthRequest, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const filterRaw = String(req.query.filter ?? 'all').toLowerCase()
  const filter = (
    ['all', 'url', 'username', 'password', 'domain'].includes(filterRaw) ? filterRaw : 'all'
  ) as SearchFilter

  if (!q) {
    return res.status(400).json({ error: 'Query pencarian wajib diisi untuk export' })
  }

  const validated = validateSearchQuery(q)
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error })
  }

  const format = String(req.query.format ?? 'txt').toLowerCase()
  const useSqliteSync = searchBackend() === 'sqlite'

  if (format === 'txt' || format === 'csv') {
    const sep = format === 'csv' ? ',' : ':'
    const filename = `credseek-${filter}-${Date.now()}.${format}`
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Cache-Control', 'no-store')
    // Send headers immediately so clients see TTFB while we stream
    res.flushHeaders?.()

    let written = 0
    let buf = ''
    const flushBuf = (force = false) => {
      if (!buf) return
      if (!force && buf.length < 512 * 1024) return
      res.write(buf)
      buf = ''
    }

    try {
      if (useSqliteSync) {
        for (const line of iterateSearchExportLines({
          q,
          filter,
          format: format === 'csv' ? 'csv' : 'txt',
          maxRows: EXCEL_EXPORT_CAP,
          batchSize: 20_000,
        })) {
          buf += `${line}\n`
          written += 1
          flushBuf()
        }
      } else {
        for await (const r of iterateSearchUnified({ q, filter, max: EXCEL_EXPORT_CAP })) {
          buf +=
            format === 'csv'
              ? `${[r.url, r.username, r.password].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')}\n`
              : `${r.url}${sep}${r.username}${sep}${r.password}\n`
          written += 1
          flushBuf()
        }
      }
      flushBuf(true)
      if (written >= EXCEL_EXPORT_CAP) {
        res.write(`\n# truncated at ${EXCEL_EXPORT_CAP.toLocaleString('en-US')} rows\n`)
      }
      res.end()
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Export gagal' })
      } else {
        res.end()
      }
    }
    return
  }

  // XLSX is heavier — keep streaming writer but sync-iterate on SQLite and skip unused columns
  const filename = `credseek-${filter}-${Date.now()}.xlsx`
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Cache-Control', 'no-store')
  res.flushHeaders?.()

  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: false,
      useSharedStrings: false,
    })
    const sheet = workbook.addWorksheet('Results')
    sheet.columns = [
      { header: 'URL', key: 'url', width: 48 },
      { header: 'Username', key: 'username', width: 24 },
      { header: 'Password', key: 'password', width: 24 },
      { header: 'Imported At', key: 'importedAt', width: 22 },
    ]
    sheet.getRow(1).commit()

    let written = 0
    const consume = (r: { url: string; username: string; password: string; importedAt: string }) => {
      sheet
        .addRow({
          url: r.url,
          username: r.username,
          password: r.password,
          importedAt: r.importedAt,
        })
        .commit()
      written += 1
    }

    if (useSqliteSync) {
      for (const r of iterateSearch({ q, filter, maxRows: EXCEL_EXPORT_CAP, batchSize: 10_000 })) {
        consume(r)
      }
    } else {
      for await (const r of iterateSearchUnified({ q, filter, max: EXCEL_EXPORT_CAP })) {
        consume(r)
      }
    }

    if (written >= EXCEL_EXPORT_CAP) {
      sheet
        .addRow({
          url: `[truncated at ${EXCEL_EXPORT_CAP.toLocaleString('en-US')} rows — use format=txt for large dumps]`,
          username: '',
          password: '',
          importedAt: '',
        })
        .commit()
    }

    await workbook.commit()
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export gagal' })
    } else {
      res.end()
    }
  }
})

app.post('/api/maintenance/optimize', authMiddleware, requireDataManager, (_req, res) => {
  try {
    const result = runMaintenance()
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Maintenance gagal' })
  }
})

app.get('/api/stats', authMiddleware, async (_req: AuthRequest, res) => {
  res.json({ totalRecords: await getRecordsCountUnified() })
})

app.get('/api/dashboard', authMiddleware, async (req: AuthRequest, res) => {
  const [stats, roleBreakdown, totalUsers] = await Promise.all([
    getDashboardStatsUnified(),
    countUsersByRole(),
    countUsers(),
  ])
  const databaseSizeBytes = getRecordsDbSizeBytesUnified()
  const storage = getDbStorageGuard()

  const enrichment =
    searchBackend() === 'sqlite' ? enrichmentStatusSnapshot() : undefined

  res.json({
    generatedAt: new Date().toISOString(),
    viewer: publicUser(req.user!),
    kpis: {
      totalRecords: stats.totalRecords,
      uniqueHosts: stats.uniqueHosts,
      importedLast24h: stats.importedLast24h,
      importedLast7: stats.importedLast7,
      totalUsers,
      databaseSizeBytes,
      databaseMaxBytes: storage.maxBytes,
      importsPaused: storage.paused,
    },
    storage,
    enrichment,
    charts: {
      importsLast7Days: stats.last7,
      protocols: stats.protocols,
      roles: roleBreakdown,
    },
    recent: stats.recent,
    capabilities: {
      canManageData: canManageData(req.user!.role),
      canManageUsers: req.user!.role === 'admin',
    },
  })
})

app.get('/api/enrichment/status', authMiddleware, (_req: AuthRequest, res) => {
  if (searchBackend() !== 'sqlite') {
    return res.json({
      dns: { done: 0, total: 0, pct: 0 },
      urlText: { done: 0, total: 0, pct: 0 },
      previews: { done: 0, total: 0, pct: 0 },
      updatedAt: new Date().toISOString(),
      recentLog: [],
      backend: searchBackend(),
    })
  }
  const cached = enrichmentStatusCache.get('sqlite')
  if (cached) return res.json(cached)
  const payload = { ...enrichmentStatusSnapshot(), backend: 'sqlite' as const }
  enrichmentStatusCache.set('sqlite', payload)
  res.json(payload)
})

app.get('/api/import/formats', authMiddleware, requireDataManager, (_req, res) => {
  res.json({
    extensions: SUPPORTED_EXTENSIONS,
    notes: [
      'Text/structured: txt, sql, csv, tsv, json, xml',
      'Archive: zip (extracts inner txt/csv/json/…; nested zip skipped)',
      'Spreadsheet: xlsx, xlsm (xls best-effort)',
      'SQLite: sqlite, db',
      'Binary DB (string harvest): accdb, mdb, mdf, ndf, ldf, bak, dump',
      'Remote: direct file URL, Telegram public post/channel (t.me/...)',
    ],
  })
})

function telegramBotPublicConfig() {
  const cfg = readTelegramConfig()
  return {
    configured: Boolean(cfg.botToken && cfg.apiId && cfg.apiHash),
    hasToken: Boolean(cfg.botToken),
    hasApi: Boolean(cfg.apiId && cfg.apiHash),
    apiId: cfg.apiId || null,
    apiHashMasked: cfg.apiHash ? '••••••••' : null,
    updatedAt: cfg.updatedAt || null,
    updatedBy: cfg.updatedBy || null,
    botTokenMasked: cfg.botToken ? '••••••••' : null,
    liveWatcher: Boolean(cfg.botToken && cfg.apiId && cfg.apiHash),
    bot: null as null | { id: string; username?: string; firstName?: string },
  }
}

app.get('/api/telegram/bot', authMiddleware, requireDataManager, (_req: AuthRequest, res) => {
  res.json(telegramBotPublicConfig())
})

app.put('/api/telegram/bot', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const body = req.body as {
      botToken?: string
      apiId?: number | string
      apiHash?: string
      clear?: boolean
    }
    if (body.clear) {
      writeTelegramConfig({})
      await stopBotClient()
      return res.json({ ...telegramBotPublicConfig(), configured: false })
    }

    const prev = readTelegramConfig()
    const botToken =
      body.botToken !== undefined && String(body.botToken).trim() !== ''
        ? String(body.botToken).trim()
        : prev.botToken || ''
    const apiHash =
      body.apiHash !== undefined && String(body.apiHash).trim() !== ''
        ? String(body.apiHash).trim()
        : prev.apiHash || ''
    const apiIdRaw =
      body.apiId !== undefined && String(body.apiId).trim() !== ''
        ? Number(body.apiId)
        : prev.apiId
    const apiId = apiIdRaw && Number.isFinite(apiIdRaw) ? Number(apiIdRaw) : undefined

    // Allow saving API credentials alone (needed for personal session import).
    // Bot token remains optional until monitors / Test connection.
    if (!apiId || !apiHash) {
      return res.status(400).json({
        error: 'apiId dan apiHash wajib diisi',
      })
    }

    writeTelegramConfig({
      ...(botToken ? { botToken } : {}),
      apiId,
      apiHash,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.email,
    })
    await stopBotClient()
    if (botToken) void ensureLiveWatcher().catch(() => undefined)
    res.json(telegramBotPublicConfig())
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal simpan bot' })
  }
})

app.post('/api/telegram/bot/test', authMiddleware, requireDataManager, async (_req, res) => {
  try {
    const me = await testBotConnection()
    res.json({ ok: true, bot: me })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test bot gagal' })
  }
})

// Legacy read alias (Import page used this)
app.get('/api/import/telegram', authMiddleware, requireDataManager, (_req, res) => {
  res.json(telegramBotPublicConfig())
})

app.get('/api/telegram/dialogs', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const limit = Number(req.query.limit) || 100
    const includeUsers =
      req.query.users === '1' || req.query.users === 'true' || req.query.includeUsers === '1'
    const dialogs = await listAccountDialogs(req.user?.id, {
      query: q,
      limit,
      includeUsers,
    })
    res.json({ dialogs, count: dialogs.length })
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Gagal memuat chat list',
    })
  }
})

app.get('/api/telegram/monitors', authMiddleware, requireDataManager, (_req, res) => {
  res.json({ monitors: readMonitors() })
})

app.get('/api/telegram/monitors/live', authMiddleware, requireDataManager, async (_req, res) => {
  try {
    const { getMonitorLiveSnapshot } = await import('./telegram/activity.js')
    res.json(getMonitorLiveSnapshot())
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Gagal memuat live monitoring',
    })
  }
})

app.post('/api/telegram/monitors', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const body = req.body as { input?: string; chatId?: string }
    const link = String(body.input || '').trim()
    const chatId = String(body.chatId || '').trim()
    // Prefer username/link when provided — don't let a leftover chat ID override it.
    const input = link || chatId
    if (!input) {
      return res.status(400).json({
        error: 'Isi link / @username, atau chat ID (contoh -1001234567890)',
      })
    }

    const resolved = await resolveAndAttachMonitor(input, req.user!.id)
    const existing = readMonitors().find((m) => m.chatId && m.chatId === resolved.chatId)
    if (existing) {
      return res.status(409).json({ error: 'Channel/group ini sudah dimonitor', monitor: existing })
    }

    const draft = createMonitorDraft(input)
    const monitor = upsertMonitor({
      ...draft,
      chatId: resolved.chatId,
      title: resolved.title,
      username: resolved.username,
      status: 'idle',
    })

    // kick off backfill async
    void backfillMonitor(monitor.id, req.user!.id).catch((err) => {
      console.warn('[tg] backfill failed:', err instanceof Error ? err.message : err)
    })
    void ensureLiveWatcher(req.user!.id).catch(() => undefined)
    res.status(201).json({ monitor: getMonitor(monitor.id) || monitor })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal menambah monitor' })
  }
})

app.delete('/api/telegram/monitors/:id', authMiddleware, requireDataManager, (req, res) => {
  const ok = removeMonitor(req.params.id!)
  if (!ok) return res.status(404).json({ error: 'Monitor tidak ditemukan' })
  res.json({ ok: true })
})

app.post('/api/telegram/monitors/:id/backfill', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const current = getMonitor(req.params.id!)
    if (!current) return res.status(404).json({ error: 'Monitor tidak ditemukan' })
    if (current.status === 'paused') {
      patchMonitor(current.id, { status: 'idle', error: undefined })
    }
    // Queue only — never await the full history walk (can take hours).
    void backfillMonitor(current.id, req.user?.id).catch((err) => {
      console.warn('[tg] backfill failed:', err instanceof Error ? err.message : err)
    })
    res.json({ monitor: getMonitor(current.id) || current })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Backfill gagal' })
  }
})

app.post('/api/telegram/monitors/:id/pause', authMiddleware, requireDataManager, (req, res) => {
  const monitor = patchMonitor(req.params.id!, { status: 'paused', error: undefined })
  if (!monitor) return res.status(404).json({ error: 'Monitor tidak ditemukan' })
  res.json({ monitor })
})

app.post('/api/telegram/monitors/:id/resume', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const current = getMonitor(req.params.id!)
    if (!current) return res.status(404).json({ error: 'Monitor tidak ditemukan' })
    if (!current.backfillDone) {
      // Unpause first so backfillMonitor doesn't throw "sedang di-pause".
      patchMonitor(current.id, { status: 'idle', error: undefined })
      void backfillMonitor(current.id, req.user?.id).catch((err) => {
        console.warn('[tg] resume backfill failed:', err instanceof Error ? err.message : err)
      })
      return res.json({ monitor: getMonitor(current.id) })
    }
    const monitor = patchMonitor(current.id, { status: 'watching', error: undefined })
    await ensureLiveWatcher(req.user?.id)
    res.json({ monitor })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Resume gagal' })
  }
})

app.get('/api/telegram/account', authMiddleware, requireDataManager, (req: AuthRequest, res) => {
  const accounts = listLinkedTelegramAccounts(req.user!.id)
  res.json({
    linked: accounts.length > 0,
    count: accounts.length,
    accounts,
    account: accounts[0] || null,
  })
})

app.post('/api/telegram/auth/start', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const { apiId, apiHash, phone } = req.body as {
      apiId?: number | string
      apiHash?: string
      phone?: string
    }
    const result = await startTelegramLogin({
      userId: req.user!.id,
      apiId: Number(apiId),
      apiHash: String(apiHash || ''),
      phone: String(phone || ''),
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal kirim kode' })
  }
})

app.post('/api/telegram/auth/confirm', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const { loginId, code } = req.body as { loginId?: string; code?: string }
    if (!loginId || !code) return res.status(400).json({ error: 'loginId dan code wajib' })
    const result = await confirmTelegramCode({
      userId: req.user!.id,
      loginId,
      code,
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Kode tidak valid' })
  }
})

app.post('/api/telegram/auth/2fa', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  try {
    const { loginId, password } = req.body as { loginId?: string; password?: string }
    if (!loginId || !password) return res.status(400).json({ error: 'loginId dan password wajib' })
    const result = await confirmTelegramPassword({
      userId: req.user!.id,
      loginId,
      password,
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Password 2FA salah' })
  }
})

app.delete('/api/telegram/account', authMiddleware, requireDataManager, (req: AuthRequest, res) => {
  const accountId =
    typeof req.query.id === 'string' && req.query.id.trim() ? req.query.id.trim() : undefined
  try {
    const result = unlinkTelegram(req.user!.id, accountId)
    const accounts = listLinkedTelegramAccounts(req.user!.id)
    res.json({
      linked: accounts.length > 0,
      count: accounts.length,
      accounts,
      ...result,
    })
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Gagal disconnect akun',
    })
  }
})

app.post(
  '/api/telegram/account/test-all',
  authMiddleware,
  requireDataManager,
  async (req: AuthRequest, res) => {
    try {
      const result = await testAllTelegramAccounts(req.user!.id)
      res.json(result)
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Test semua akun gagal',
      })
    }
  },
)

app.post(
  '/api/telegram/account/:id/test',
  authMiddleware,
  requireDataManager,
  async (req: AuthRequest, res) => {
    try {
      const result = await testTelegramAccount(req.user!.id, req.params.id!)
      res.json(result)
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Test koneksi gagal',
      })
    }
  },
)

app.post(
  '/api/telegram/auth/session',
  authMiddleware,
  requireDataManager,
  (req, res, next) => {
    const contentType = String(req.headers['content-type'] || '')
    if (contentType.includes('multipart/form-data')) {
      return upload.single('session')(req, res, next)
    }
    next()
  },
  async (req: AuthRequest, res) => {
    try {
      const body = req.body as {
        apiId?: string | number
        apiHash?: string
        stringSession?: string
      }
      const file = req.file
      let account
      if (file?.buffer?.length) {
        account = await importTelegramSessionFile({
          userId: req.user!.id,
          sessionBytes: file.buffer,
          apiId: body.apiId,
          apiHash: body.apiHash,
        })
      } else if (typeof body.stringSession === 'string' && body.stringSession.trim()) {
        account = await importTelegramStringSession({
          userId: req.user!.id,
          stringSession: body.stringSession,
          apiId: body.apiId,
          apiHash: body.apiHash,
        })
      } else {
        return res.status(400).json({
          error: 'Upload file .session (Telethon/Pyrogram) atau kirim stringSession',
        })
      }
      const accounts = listLinkedTelegramAccounts(req.user!.id)
      res.json({ linked: true, count: accounts.length, account, accounts })
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal import session Telegram',
      })
    }
  },
)

app.get('/api/storage', authMiddleware, requireDataManager, (_req, res) => {
  res.json(getDbStorageGuard())
})

app.put('/api/storage', authMiddleware, requireAdmin, (req: AuthRequest, res) => {
  try {
    const body = req.body as { maxGb?: number; maxBytes?: number }
    let guard
    if (body.maxBytes != null) {
      guard = setMaxDbBytes(Number(body.maxBytes))
    } else if (body.maxGb != null) {
      guard = setMaxDbGb(Number(body.maxGb))
    } else {
      return res.status(400).json({ error: 'Kirim maxGb (atau maxBytes)' })
    }
    res.json(guard)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal set batas DB' })
  }
})

app.post(
  '/api/import/url',
  authMiddleware,
  requireDataManager,
  requireImportCapacity,
  rateLimitMiddleware({ name: 'import', limit: 60, windowSec: 3600, byUser: true }),
  async (req: AuthRequest, res) => {
    try {
      const { url, urls, async: asyncMode } = req.body as {
        url?: string
        urls?: string[]
        async?: boolean
      }
      const list = [...(url ? [url] : []), ...(Array.isArray(urls) ? urls : [])]
        .map((u) => u.trim())
        .filter(Boolean)

      if (!list.length) {
        return res.status(400).json({ error: 'Sertakan url atau urls[]' })
      }
      if (list.length > 20) {
        return res.status(400).json({ error: 'Maksimal 20 URL per request' })
      }

      if (asyncMode) {
        const job = await createImportJob({
          userId: req.user!.id,
          kind: 'url',
          payload: { urls: list },
        })
        return res.status(202).json({ jobId: job.id, status: job.status })
      }

      let added = 0
      let skipped = 0
      const results = []

      for (const remoteUrl of list) {
        try {
          const imported = await importFromRemoteUrl(remoteUrl, req.user!.id)
          const saved = await insertCredentialsUnified(imported.credentials)
          added += saved.added
          skipped += saved.skipped
          results.push({
            url: remoteUrl,
            source: imported.source,
            kind: imported.kind,
            filename: imported.filename,
            format: imported.meta.format,
            extracted: imported.meta.extracted,
            added: saved.added,
            skipped: saved.skipped,
            warning: imported.meta.warning,
            error: imported.meta.error,
          })
        } catch (err) {
          results.push({
            url: remoteUrl,
            source: remoteUrl,
            kind: /t\.me|telegram\.me/i.test(remoteUrl) ? 'telegram' : 'url',
            filename: '',
            format: 'remote',
            extracted: 0,
            added: 0,
            skipped: 0,
            error: err instanceof Error ? err.message : 'Gagal import URL',
          })
        }
      }

      res.json({
        added,
        skipped,
        total: await getRecordsCountUnified(),
        results,
      })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import URL gagal' })
    }
  },
)

app.post(
  '/api/import',
  authMiddleware,
  requireDataManager,
  requireImportCapacity,
  rateLimitMiddleware({ name: 'import', limit: 60, windowSec: 3600, byUser: true }),
  upload.single('file'),
  async (req: AuthRequest, res) => {
    try {
      if (req.file) {
        const wantStream =
          req.query.stream === '1' ||
          String(req.headers.accept || '').includes('application/x-ndjson')

        const writeProgress = (ev: ImportProgressEvent) => {
          if (!wantStream || res.writableEnded) return
          res.write(`${JSON.stringify(ev)}\n`)
        }

        if (wantStream) {
          res.status(200)
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.setHeader('X-Accel-Buffering', 'no')
          // @ts-expect-error flushHeaders exists on Node ServerResponse
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          writeProgress({
            type: 'progress',
            phase: 'receive',
            pct: 100,
            overallPct: 5,
            message: `Upload diterima · antrean worker · ${req.file.originalname} · ${(req.file.size / (1024 * 1024)).toFixed(2)} MB`,
            done: req.file.size,
            total: req.file.size,
          })
        }

        // Heavy parse/insert runs in a separate Node process so the web event loop stays free.
        const result = await enqueueIsolatedImport(() =>
          runIsolatedFileImport({
            filename: req.file!.originalname,
            buffer: req.file!.buffer,
            onProgress: (ev) => {
              writeProgress(ev)
              if (ev.pct === 0 || ev.pct >= 100 || (ev.pct > 0 && ev.pct % 25 === 0)) {
                console.log(
                  `[import:progress] ${req.file!.originalname} · ${ev.phase} ${ev.pct}% · ${ev.message}`,
                )
              }
            },
          }),
        )

        adoptExternalImportTotal(result.total)
        console.log(
          `[import] ${req.file.originalname}: extracted ${result.extracted ?? '?'} · parse ${result.timing?.parseMs ?? '?'}ms · insert ${result.timing?.insertMs ?? '?'}ms · +${result.added}/skip ${result.skipped}`,
        )
        setImmediate(() => {
          try {
            ensureDedupeIndex()
          } catch (err) {
            console.warn(
              '[dedupe] after import index skipped:',
              err instanceof Error ? err.message : err,
            )
          }
        })

        if (wantStream) {
          res.write(`${JSON.stringify({ type: 'done', ...result })}\n`)
          return res.end()
        }

        return res.json(result)
      }

      if (typeof req.body?.text === 'string') {
        if (req.body.async === '1' || req.body.async === true) {
          const job = await createImportJob({
            userId: req.user!.id,
            kind: 'text',
            payload: { text: req.body.text },
          })
          return res.status(202).json({ jobId: job.id, status: job.status })
        }
        const batch: NonNullable<ReturnType<typeof parseCredentialLine>>[] = []
        let skippedInvalid = 0
        for (const line of req.body.text.split(/\r?\n/)) {
          const item = parseCredentialLine(line)
          if (!item) {
            if (line.trim()) skippedInvalid += 1
            continue
          }
          batch.push(item)
        }
        const saved = await insertCredentialsUnified(batch)
        return res.json({
          added: saved.added,
          skipped: saved.skipped + skippedInvalid,
          total: saved.total,
        })
      }

      return res.status(400).json({ error: 'Kirim file atau text' })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import gagal' })
    }
  },
)

app.post(
  '/api/import/bulk',
  authMiddleware,
  requireDataManager,
  requireImportCapacity,
  rateLimitMiddleware({ name: 'import', limit: 60, windowSec: 3600, byUser: true }),
  upload.array('files', 30),
  async (req: AuthRequest, res) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) || []
      if (!files.length) {
        return res.status(400).json({ error: 'Upload minimal 1 file' })
      }

      let added = 0
      let skipped = 0
      const filesResult = []

      for (const file of files) {
        const t0 = Date.now()
        const parsed = await parseImportFile(file.originalname, file.buffer)
        const t1 = Date.now()
        const saved = await insertCredentialsUnified(parsed.credentials)
        const t2 = Date.now()
        console.log(
          `[import] ${file.originalname}: ${parsed.credentials.length} creds · parse ${t1 - t0}ms · insert ${t2 - t1}ms · +${saved.added}/skip ${saved.skipped}`,
        )
        added += saved.added
        skipped += saved.skipped
        filesResult.push({
          ...parsed.meta,
          added: saved.added,
          skipped: saved.skipped,
        })
      }

      res.json({
        added,
        skipped,
        total: await getRecordsCountUnified(),
        files: filesResult,
      })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Bulk import gagal' })
    }
  },
)

/** Async bulk import — writes files to disk staging and enqueues worker job. */
app.post(
  '/api/import/bulk-async',
  authMiddleware,
  requireDataManager,
  requireImportCapacity,
  rateLimitMiddleware({ name: 'import', limit: 30, windowSec: 3600, byUser: true }),
  uploadDisk.array('files', 30),
  async (req: AuthRequest, res) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) || []
      if (!files.length) return res.status(400).json({ error: 'Upload minimal 1 file' })

      const job = await createImportJob({
        userId: req.user!.id,
        kind: 'file',
        payload: { files: [] },
        enqueue: false,
      })

      const staged = files.map((f) => {
        const dest = stagingPath(job.id, f.originalname)
        fs.renameSync(f.path, dest)
        return { path: dest, filename: f.originalname }
      })

      await patchImportJob(job.id, { payload: { files: staged } })
      await enqueueExistingJob(job.id)
      res.status(202).json({ jobId: job.id, status: job.status, files: staged.length })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Async import gagal' })
    }
  },
)

app.get('/api/import/jobs', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  const statusRaw = String(req.query.status || '').trim()
  const includeFinished =
    String(req.query.includeFinished || req.query.all || '').trim() === '1' ||
    String(req.query.includeFinished || req.query.all || '')
      .trim()
      .toLowerCase() === 'true'
  // Default: only active jobs so finished processes leave the user UI ("Proses di server").
  const statuses = statusRaw
    ? (statusRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as Array<'queued' | 'running' | 'done' | 'error' | 'cancelled'>)
    : includeFinished
      ? undefined
      : (['queued', 'running'] as Array<'queued' | 'running'>)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40))
  const mineOnly = req.user!.role !== 'admin'
  const jobs = await listImportJobs({
    userId: mineOnly ? req.user!.id : undefined,
    statuses,
    limit,
  })
  // Non-admin: only own jobs (listImportJobs already filtered). Admin sees all when no userId.
  const visible =
    req.user!.role === 'admin'
      ? jobs
      : jobs.filter((j) => !j.userId || j.userId === req.user!.id)
  res.json({
    jobs: visible.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      progress: j.progress,
      error: j.error,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      files: Array.isArray((j.payload as { files?: unknown }).files)
        ? ((j.payload as { files: Array<{ filename: string }> }).files || []).map((f) => f.filename)
        : [],
    })),
  })
})

app.get('/api/import/jobs/:id', authMiddleware, requireDataManager, async (req: AuthRequest, res) => {
  const job = await getImportJob(String(req.params.id))
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' })
  if (job.userId && job.userId !== req.user!.id && req.user!.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  res.json({ job })
})

app.post(
  '/api/import/jobs/:id/cancel',
  authMiddleware,
  requireDataManager,
  async (req: AuthRequest, res) => {
    const job = await getImportJob(String(req.params.id))
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' })
    if (job.userId && job.userId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (job.status === 'done' || job.status === 'cancelled') {
      return res.json({ job })
    }
    const next = await patchImportJob(job.id, {
      status: 'cancelled',
      progress: { ...job.progress, phase: 'done', message: 'Dibatalkan' },
    })
    res.json({ job: next })
  },
)

app.post('/api/records/dedupe', authMiddleware, requireDataManager, async (_req: AuthRequest, res) => {
  if (searchBackend() === 'opensearch') {
    return res.status(400).json({ error: 'Dedupe SQLite tidak berlaku saat SEARCH_BACKEND=opensearch' })
  }
  const result = dedupeDatabase()
  res.json({ ok: true, removed: result.removed, total: result.total })
})

app.delete('/api/records', authMiddleware, requireDataManager, async (_req: AuthRequest, res) => {
  await clearAllRecordsUnified()
  res.json({ ok: true, total: 0 })
})

app.get('/api/health', async (_req, res) => {
  const records = await getRecordsCountUnified().catch(() => -1)
  const mem = process.memoryUsage()
  res.json({
    ok: records >= 0,
    records,
    searchBackend: searchBackend(),
    postgres: hasPostgres(),
    redis: Boolean(config.redisUrl),
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
    },
    guard: getGuardSample(),
  })
})

// Dedicated HTML apps (subscribe / billing / docs) live in /public and must not hit SPA fallback.
const publicHtml = path.resolve(__dirname, '../public')
app.get(['/subscribe', '/subscribe.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(path.join(publicHtml, 'subscribe.html'))
})
app.get(['/admin/billing', '/admin-billing', '/admin-billing.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(path.join(publicHtml, 'admin-billing.html'))
})
// Public client docs stay at /docs. In-app API Docs uses SPA route /api-docs.
app.get(['/docs', '/docs.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(path.join(publicHtml, 'docs.html'))
})

if (fs.existsSync(distDir)) {
  // Fingerprinted assets can be cached; HTML must always revalidate so new JS loads.
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), { maxAge: '7d', immutable: true, fallthrough: true }),
  )
  app.use(express.static(distDir, { index: false, maxAge: 0, fallthrough: true }))
  app.get(/^(?!\/api(?:\/|$)|\/assets(?:\/|$)).*/, (req, res, next) => {
    const p = req.path || '/'
    if (
      p === '/subscribe' ||
      p === '/subscribe.html' ||
      p === '/admin/billing' ||
      p === '/admin-billing' ||
      p === '/admin-billing.html' ||
      p === '/docs' ||
      p === '/docs.html'
    ) {
      return next()
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

async function boot() {
  assertProdSecrets()
  startRuntimeGuard()
  startImportJobRunner()
  startPaymentPoller()

  if (hasPostgres()) {
    await initPostgres()
    const migratedUsers = await migrateUsersJsonToPostgres()
    if (migratedUsers.migrated) {
      console.log(`Migrated ${migratedUsers.count} users → Postgres`)
    }
  } else {
    console.warn('DATABASE_URL not set — using users.json fallback')
  }

  if (searchBackend() === 'sqlite') {
    initRecordsDb()
    try {
      const migrated = await migrateJsonToSqliteIfNeeded()
      if (migrated.migrated) {
        console.log(`SQLite ready with ${migrated.count.toLocaleString()} records`)
      }
    } catch (err) {
      console.error('Failed to migrate records.json → SQLite:', err)
    }
  }

  await initSearchBackend()

  const records = await getRecordsCountUnified()
  app.listen(PORT, HOST, () => {
    console.log(
      `CredSeek ready on http://${HOST}:${PORT} (${records.toLocaleString()} records, backend=${searchBackend()})`,
    )
    if (searchBackend() === 'sqlite') {
      warmDashboardStats()
      // Ensure unique index in background. Skip full-table boot dedupe — on ~9M rows
      // it blocks the event loop (health/web timeout). Use POST /api/records/dedupe instead.
      setTimeout(() => {
        try {
          ensureDedupeIndex()
          console.log('[dedupe] unique index ok')
        } catch (err) {
          console.warn(
            '[dedupe] index create skipped (duplicates may exist) — run /api/records/dedupe manually:',
            err instanceof Error ? err.message : err,
          )
        }
      }, 5000)
      setTimeout(() => startEnrichmentWorker(), 8000)
    }
    void pauseInterruptedBackfillsOnStartup()
      .then((n) => {
        if (n > 0) console.log(`[tg] paused ${n} interrupted backfill(s) after restart`)
      })
      .catch(() => undefined)
    void ensureLiveWatcher().catch((err) => {
      console.warn('Telegram watcher not started:', err instanceof Error ? err.message : err)
    })
  })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closePreviewBrowser().finally(() => process.exit(0))
  })
}

void boot()
