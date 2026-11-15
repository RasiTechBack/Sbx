export type SubscriptionPlan = {
  id: string
  name: string
  description: string
  priceIdr: number
  durationDays: number
  features: string[]
  highlight?: boolean
}

const DEFAULT_PLANS: SubscriptionPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'Cocok untuk uji pencarian & tim kecil',
    priceIdr: 25_000,
    durationDays: 30,
    features: ['Full search tanpa mask', 'Export terbatas', 'Dukungan email'],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Untuk operasional harian SOC / analyst',
    priceIdr: 75_000,
    durationDays: 30,
    highlight: true,
    features: ['Semua fitur Starter', 'Export penuh', 'Prioritas dukungan'],
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Paket panjang untuk tim',
    priceIdr: 150_000,
    durationDays: 90,
    features: ['Semua fitur Pro', '3 bulan aktif', 'Onboarding singkat'],
  },
]

function parseEnvPlans(): SubscriptionPlan[] | null {
  const raw = process.env.SUBSCRIPTION_PACKAGES_JSON
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as SubscriptionPlan[]
    if (!Array.isArray(parsed) || !parsed.length) return null
    return parsed.filter((p) => p?.id && p?.name && Number(p.priceIdr) > 0 && Number(p.durationDays) > 0)
  } catch {
    return null
  }
}

export function listPlans(): SubscriptionPlan[] {
  return parseEnvPlans() || DEFAULT_PLANS
}

export function getPlan(id: string): SubscriptionPlan | null {
  const key = String(id || '').trim().toLowerCase()
  return listPlans().find((p) => p.id.toLowerCase() === key) || null
}
