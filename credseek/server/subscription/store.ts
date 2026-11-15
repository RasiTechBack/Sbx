import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { Role, User } from '../store.js'
import { getPlan, listPlans, type SubscriptionPlan } from './packages.js'

export type SubscriptionStatus = 'none' | 'trial' | 'active' | 'expired'

export type UserSubscription = {
  userId: string
  status: SubscriptionStatus
  planId: string | null
  planName: string | null
  startsAt: string | null
  expiresAt: string | null
  trial: boolean
  source: 'payment' | 'trial' | 'manual' | null
  paymentId: string | null
  note: string | null
  updatedAt: string
}

export type PaymentRecord = {
  id: string
  providerPaymentId: string
  userId: string
  planId: string
  planName: string
  nominal: number
  amountCharged: number
  currency: string
  qrString: string
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'
  createdAt: string
  updatedAt: string
  paidAt: string | null
}

type SubFile = { subscriptions: Record<string, UserSubscription> }
type PayFile = { payments: PaymentRecord[] }

const subsPath = path.join(config.dataDir, 'subscriptions.json')
const paysPath = path.join(config.dataDir, 'payments.json')

function ensureFiles() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  if (!fs.existsSync(subsPath)) {
    fs.writeFileSync(subsPath, JSON.stringify({ subscriptions: {} } satisfies SubFile, null, 2))
  }
  if (!fs.existsSync(paysPath)) {
    fs.writeFileSync(paysPath, JSON.stringify({ payments: [] } satisfies PayFile, null, 2))
  }
}

function readSubs(): SubFile {
  ensureFiles()
  try {
    return JSON.parse(fs.readFileSync(subsPath, 'utf8')) as SubFile
  } catch {
    return { subscriptions: {} }
  }
}

function writeSubs(data: SubFile) {
  ensureFiles()
  fs.writeFileSync(subsPath, JSON.stringify(data, null, 2), 'utf8')
}

function readPays(): PayFile {
  ensureFiles()
  try {
    return JSON.parse(fs.readFileSync(paysPath, 'utf8')) as PayFile
  } catch {
    return { payments: [] }
  }
}

function writePays(data: PayFile) {
  ensureFiles()
  fs.writeFileSync(paysPath, JSON.stringify(data, null, 2), 'utf8')
}

function emptySub(userId: string): UserSubscription {
  return {
    userId,
    status: 'none',
    planId: null,
    planName: null,
    startsAt: null,
    expiresAt: null,
    trial: false,
    source: null,
    paymentId: null,
    note: null,
    updatedAt: new Date().toISOString(),
  }
}

export function refreshSubscriptionStatus(sub: UserSubscription): UserSubscription {
  if ((sub.status === 'active' || sub.status === 'trial') && sub.expiresAt) {
    if (Date.parse(sub.expiresAt) <= Date.now()) {
      return {
        ...sub,
        status: 'expired',
        updatedAt: new Date().toISOString(),
      }
    }
  }
  return sub
}

export function getUserSubscription(userId: string): UserSubscription {
  const all = readSubs()
  const raw = all.subscriptions[userId] || emptySub(userId)
  const next = refreshSubscriptionStatus(raw)
  if (next.status !== raw.status) {
    all.subscriptions[userId] = next
    writeSubs(all)
  }
  return next
}

export function upsertUserSubscription(
  userId: string,
  patch: Partial<UserSubscription>,
): UserSubscription {
  const all = readSubs()
  const current = all.subscriptions[userId] || emptySub(userId)
  const next: UserSubscription = refreshSubscriptionStatus({
    ...current,
    ...patch,
    userId,
    updatedAt: new Date().toISOString(),
  })
  all.subscriptions[userId] = next
  writeSubs(all)
  return next
}

export function listSubscriptions(): UserSubscription[] {
  const all = readSubs()
  return Object.values(all.subscriptions).map(refreshSubscriptionStatus)
}

export function roleBypassesSubscription(role: Role | undefined) {
  return role === 'admin' || role === 'dev'
}

export function userHasActiveAccess(user: User): boolean {
  if (roleBypassesSubscription(user.role)) return true
  const sub = getUserSubscription(user.id)
  return sub.status === 'active' || sub.status === 'trial'
}

export function publicSubscription(user: User) {
  if (roleBypassesSubscription(user.role)) {
    return {
      status: 'active' as const,
      planId: 'staff',
      planName: user.role === 'admin' ? 'Admin' : 'Developer',
      startsAt: user.createdAt,
      expiresAt: null,
      trial: false,
      source: 'manual' as const,
      paymentId: null,
      active: true,
      bypass: true,
    }
  }
  const sub = getUserSubscription(user.id)
  return {
    status: sub.status,
    planId: sub.planId,
    planName: sub.planName,
    startsAt: sub.startsAt,
    expiresAt: sub.expiresAt,
    trial: sub.trial,
    source: sub.source,
    paymentId: sub.paymentId,
    active: sub.status === 'active' || sub.status === 'trial',
    bypass: false,
    note: sub.note,
  }
}

export function activatePlanForUser(opts: {
  userId: string
  plan: SubscriptionPlan
  source: 'payment' | 'trial' | 'manual'
  paymentId?: string | null
  trial?: boolean
  days?: number
  note?: string | null
  fromDate?: Date
}) {
  const start = opts.fromDate || new Date()
  const days = Math.max(1, Number(opts.days || opts.plan.durationDays))
  const expires = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
  return upsertUserSubscription(opts.userId, {
    status: opts.trial || opts.source === 'trial' ? 'trial' : 'active',
    planId: opts.plan.id,
    planName: opts.plan.name,
    startsAt: start.toISOString(),
    expiresAt: expires.toISOString(),
    trial: Boolean(opts.trial || opts.source === 'trial'),
    source: opts.source,
    paymentId: opts.paymentId || null,
    note: opts.note || null,
  })
}

export function createPaymentRecord(input: {
  providerPaymentId: string
  userId: string
  plan: SubscriptionPlan
  nominal: number
  amountCharged: number
  currency: string
  qrString: string
}): PaymentRecord {
  const now = new Date().toISOString()
  const row: PaymentRecord = {
    id: randomUUID(),
    providerPaymentId: input.providerPaymentId,
    userId: input.userId,
    planId: input.plan.id,
    planName: input.plan.name,
    nominal: input.nominal,
    amountCharged: input.amountCharged,
    currency: input.currency,
    qrString: input.qrString,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    paidAt: null,
  }
  const all = readPays()
  all.payments.unshift(row)
  // keep last 2000
  all.payments = all.payments.slice(0, 2000)
  writePays(all)
  return row
}

export function findPaymentById(id: string): PaymentRecord | null {
  return readPays().payments.find((p) => p.id === id || p.providerPaymentId === id) || null
}

export function listPayments(opts?: { userId?: string; limit?: number }) {
  let rows = readPays().payments
  if (opts?.userId) rows = rows.filter((p) => p.userId === opts.userId)
  return rows.slice(0, Math.min(200, Math.max(1, opts?.limit || 50)))
}

export function updatePayment(id: string, patch: Partial<PaymentRecord>): PaymentRecord | null {
  const all = readPays()
  const idx = all.payments.findIndex((p) => p.id === id || p.providerPaymentId === id)
  if (idx < 0) return null
  const next = {
    ...all.payments[idx]!,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  all.payments[idx] = next
  writePays(all)
  return next
}

export function markPaymentPaid(payment: PaymentRecord): {
  payment: PaymentRecord
  subscription: UserSubscription
} {
  const plan = getPlan(payment.planId) || {
    id: payment.planId,
    name: payment.planName,
    description: '',
    priceIdr: payment.nominal,
    durationDays: 30,
    features: [],
  }
  const paid = updatePayment(payment.id, {
    status: 'PAID',
    paidAt: new Date().toISOString(),
  })!
  const subscription = activatePlanForUser({
    userId: payment.userId,
    plan,
    source: 'payment',
    paymentId: payment.providerPaymentId,
    trial: false,
  })
  return { payment: paid, subscription }
}

export function getCatalog() {
  return listPlans()
}
