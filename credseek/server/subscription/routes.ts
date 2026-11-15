import type express from 'express'
import type { User } from '../store.js'
import { findUserById, createUser, listUsersPaged } from '../users/repo.js'
import { getPlan, listPlans } from './packages.js'
import { checkSaweriaPayment, createSaweriaPayment } from './saweria.js'
import {
  activatePlanForUser,
  createPaymentRecord,
  findPaymentById,
  getCatalog,
  getUserSubscription,
  listPayments,
  listSubscriptions,
  markPaymentPaid,
  publicSubscription,
  updatePayment,
  upsertUserSubscription,
  userHasActiveAccess,
} from './store.js'

type AuthRequest = express.Request & { user?: User }

export function requireActiveSubscription(
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (userHasActiveAccess(req.user)) return next()
  return res.status(402).json({
    error: 'Langganan belum aktif. Silakan pilih paket dan bayar QRIS untuk mengakses fitur.',
    code: 'SUBSCRIPTION_REQUIRED',
    subscription: publicSubscription(req.user),
    checkoutPath: '/subscribe',
  })
}

/** For optionalAuth routes: block logged-in users without plan; allow guests. */
export function blockInactiveMembers(
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction,
) {
  if (req.user && !userHasActiveAccess(req.user)) {
    return res.status(402).json({
      error: 'Langganan belum aktif. Aktifkan paket di /subscribe',
      code: 'SUBSCRIPTION_REQUIRED',
      subscription: publicSubscription(req.user),
      checkoutPath: '/subscribe',
    })
  }
  next()
}

async function syncPaymentStatus(paymentId: string) {
  const payment = findPaymentById(paymentId)
  if (!payment) return null
  if (payment.status === 'PAID') {
    return { payment, subscription: getUserSubscription(payment.userId), checked: payment.status }
  }
  const checked = await checkSaweriaPayment(payment.providerPaymentId)
  if (checked.paid) {
    return { ...markPaymentPaid(payment), checked: checked.status }
  }
  const normalized = String(checked.status || 'PENDING').toUpperCase()
  const nextStatus =
    normalized === 'PENDING' || normalized === 'SUKSES' || normalized === 'SUCCESS'
      ? payment.status
      : payment.status
  if (normalized && normalized !== 'PENDING' && !checked.paid) {
    // keep PENDING unless provider says expired/failed keywords
    if (/expire|gagal|fail|cancel/i.test(checked.status)) {
      updatePayment(payment.id, { status: 'FAILED' })
    }
  }
  return {
    payment: findPaymentById(payment.id)!,
    subscription: getUserSubscription(payment.userId),
    checked: checked.status || nextStatus,
  }
}

export function mountSubscriptionRoutes(
  app: express.Express,
  deps: {
    authMiddleware: (
      req: AuthRequest,
      res: express.Response,
      next: express.NextFunction,
    ) => unknown
    requireAdmin: (
      req: AuthRequest,
      res: express.Response,
      next: express.NextFunction,
    ) => unknown
    publicUser: (user: User) => Record<string, unknown>
    bcryptHash: (password: string, rounds: number) => Promise<string>
  },
) {
  const { authMiddleware, requireAdmin, publicUser, bcryptHash } = deps

  app.get('/api/subscription/plans', (_req, res) => {
    res.json({ plans: getCatalog() })
  })

  app.get('/api/subscription/me', authMiddleware, (req: AuthRequest, res) => {
    res.json({
      user: publicUser(req.user!),
      subscription: publicSubscription(req.user!),
      plans: listPlans(),
    })
  })

  app.post('/api/subscription/checkout', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const planId = String((req.body as { planId?: string }).planId || '').trim()
      const plan = getPlan(planId)
      if (!plan) return res.status(400).json({ error: 'Paket tidak ditemukan' })
      if (userHasActiveAccess(req.user!) && req.user!.role === 'user') {
        const sub = getUserSubscription(req.user!.id)
        if (sub.status === 'active' || sub.status === 'trial') {
          // allow renew/upgrade anyway
        }
      }

      const created = await createSaweriaPayment(plan.priceIdr)
      const payment = createPaymentRecord({
        providerPaymentId: created.id,
        userId: req.user!.id,
        plan,
        nominal: plan.priceIdr,
        amountCharged: created.amount,
        currency: created.currency,
        qrString: created.qrString,
      })

      res.status(201).json({
        payment: {
          id: payment.id,
          providerPaymentId: payment.providerPaymentId,
          planId: payment.planId,
          planName: payment.planName,
          nominal: payment.nominal,
          amountCharged: payment.amountCharged,
          currency: payment.currency,
          qrString: payment.qrString,
          status: payment.status,
          createdAt: payment.createdAt,
        },
        plan,
      })
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gagal membuat payment',
      })
    }
  })

  app.get('/api/subscription/payments/:id', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const payment = findPaymentById(String(req.params.id))
      if (!payment) return res.status(404).json({ error: 'Payment tidak ditemukan' })
      if (payment.userId !== req.user!.id && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' })
      }
      const synced = await syncPaymentStatus(payment.id)
      res.json({
        payment: synced?.payment || payment,
        subscription: synced?.subscription || getUserSubscription(payment.userId),
        providerStatus: synced?.checked,
      })
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gagal cek payment',
      })
    }
  })

  app.get('/api/subscription/payments', authMiddleware, (req: AuthRequest, res) => {
    const userId = req.user!.role === 'admin' ? String(req.query.userId || '') || undefined : req.user!.id
    res.json({ payments: listPayments({ userId, limit: Number(req.query.limit) || 50 }) })
  })

  // ---- Admin: trial + manual activation + create trial user ----
  app.get('/api/admin/subscriptions', authMiddleware, requireAdmin, (_req, res) => {
    res.json({
      subscriptions: listSubscriptions(),
      plans: listPlans(),
      payments: listPayments({ limit: 100 }),
    })
  })

  app.post(
    '/api/admin/users/:id/subscription',
    authMiddleware,
    requireAdmin,
    async (req: AuthRequest, res) => {
      const user = await findUserById(String(req.params.id))
      if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })

      const body = req.body as {
        action?: 'activate' | 'trial' | 'expire' | 'clear'
        planId?: string
        days?: number
        note?: string
      }
      const action = body.action || 'activate'

      if (action === 'clear' || action === 'expire') {
        const sub = upsertUserSubscription(user.id, {
          status: action === 'clear' ? 'none' : 'expired',
          planId: action === 'clear' ? null : getUserSubscription(user.id).planId,
          planName: action === 'clear' ? null : getUserSubscription(user.id).planName,
          trial: false,
          source: 'manual',
          note: body.note || (action === 'expire' ? 'Dinonaktifkan manual' : 'Direset manual'),
          expiresAt: action === 'expire' ? new Date().toISOString() : null,
          startsAt: action === 'clear' ? null : getUserSubscription(user.id).startsAt,
          paymentId: null,
        })
        return res.json({ user: publicUser(user), subscription: publicSubscription(user), stored: sub })
      }

      const plan = getPlan(String(body.planId || 'starter')) || listPlans()[0]
      if (!plan) return res.status(400).json({ error: 'Paket tidak valid' })
      const days = Math.max(1, Number(body.days || (action === 'trial' ? 7 : plan.durationDays)))
      const sub = activatePlanForUser({
        userId: user.id,
        plan,
        source: action === 'trial' ? 'trial' : 'manual',
        trial: action === 'trial',
        days,
        note: body.note || (action === 'trial' ? 'Trial admin' : 'Aktivasi manual admin'),
      })
      res.json({
        user: publicUser(user),
        subscription: publicSubscription(user),
        stored: sub,
      })
    },
  )

  app.post('/api/admin/trial-users', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
    const body = req.body as {
      name?: string
      email?: string
      password?: string
      planId?: string
      days?: number
      note?: string
    }
    if (!body.name?.trim() || !body.email?.trim() || !body.password || body.password.length < 6) {
      return res.status(400).json({ error: 'Nama, email, dan password (min 6) wajib' })
    }
    const plan = getPlan(String(body.planId || 'starter')) || listPlans()[0]!
    const days = Math.max(1, Number(body.days || 7))
    try {
      const user = await createUser({
        name: body.name,
        email: body.email,
        passwordHash: await bcryptHash(body.password, 10),
        role: 'user',
      })
      const sub = activatePlanForUser({
        userId: user.id,
        plan,
        source: 'trial',
        trial: true,
        days,
        note: body.note || 'Akun trial dari admin',
      })
      res.status(201).json({
        user: publicUser(user),
        subscription: publicSubscription(user),
        stored: sub,
        trialDays: days,
      })
    } catch (err) {
      if (err instanceof Error && /EMAIL_TAKEN|unique/i.test(err.message)) {
        return res.status(409).json({ error: 'Email sudah terdaftar' })
      }
      throw err
    }
  })

  // Convenience: enriched users list for billing admin UI
  app.get('/api/admin/users-billing', authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
    const q = String(req.query.q ?? '')
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const result = await listUsersPaged({ q, page, limit })
    res.json({
      users: result.users.map((u) => ({
        ...publicUser(u),
        subscription: publicSubscription(u),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
      plans: listPlans(),
    })
  })
}

export function startPaymentPoller() {
  const enabled = String(process.env.SUBSCRIPTION_POLL || '1') !== '0'
  if (!enabled) return
  const tickMs = Math.max(10_000, Number(process.env.SUBSCRIPTION_POLL_MS || 20000))
  setInterval(() => {
    void (async () => {
      const pending = listPayments({ limit: 100 }).filter((p) => p.status === 'PENDING')
      for (const p of pending.slice(0, 15)) {
        try {
          await syncPaymentStatus(p.id)
        } catch {
          /* ignore transient */
        }
      }
    })()
  }, tickMs).unref?.()
}
