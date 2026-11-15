export type SaweriaCreateResult = {
  id: string
  amount: number
  amountDisplay: number
  currency: string
  status: string
  paymentType: string
  qrString: string
  createdAt: string
  raw: unknown
}

export type SaweriaCheckResult = {
  success: boolean
  id: string
  status: string
  paid: boolean
  raw: unknown
}

function createUrl(nominal: number) {
  const base = (process.env.SAWERIA_CREATE_URL || 'https://rasitech.org/saweria/').replace(/\?$/, '')
  const url = new URL(base.includes('?') ? base : `${base}${base.endsWith('/') ? '' : '/'}`)
  // Support both https://host/saweria/ and https://host/saweria/?nominal=
  url.searchParams.set('nominal', String(Math.max(1000, Math.floor(nominal))))
  return url.toString().replace(/\/\?/, '/?')
}

function checkUrl(id: string) {
  const base =
    process.env.SAWERIA_CHECK_URL || 'https://rasitech.org/saweria/cek.php'
  const url = new URL(base)
  url.searchParams.set('id', id)
  return url.toString()
}

export async function createSaweriaPayment(nominal: number): Promise<SaweriaCreateResult> {
  const endpoint = createUrl(nominal)
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CredSeek-Subscription/1.0',
    },
  })
  if (!res.ok) {
    throw new Error(`Gagal membuat payment QRIS (HTTP ${res.status})`)
  }
  const body = (await res.json()) as { data?: Record<string, unknown> }
  const data = body?.data
  if (!data || typeof data !== 'object') {
    throw new Error('Response payment tidak valid')
  }
  const id = String(data.id || '')
  const qrString = String(data.qr_string || '')
  if (!id || !qrString) {
    throw new Error('Payment QRIS tidak lengkap (id/qr_string)')
  }
  const etc = (data.etc || {}) as Record<string, unknown>
  return {
    id,
    amount: Number(data.amount ?? data.amount_raw ?? nominal) || nominal,
    amountDisplay: Number(etc.amount_to_display ?? nominal) || nominal,
    currency: String(data.currency || 'IDR'),
    status: String(data.status || 'PENDING'),
    paymentType: String(data.payment_type || 'qris'),
    qrString,
    createdAt: String(data.created_at || new Date().toISOString()),
    raw: body,
  }
}

export async function checkSaweriaPayment(id: string): Promise<SaweriaCheckResult> {
  const endpoint = checkUrl(id)
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CredSeek-Subscription/1.0',
    },
  })
  if (!res.ok) {
    throw new Error(`Gagal cek payment (HTTP ${res.status})`)
  }
  const body = (await res.json()) as {
    success?: boolean
    id?: string
    status?: string
  }
  const status = String(body.status || '').trim()
  const paid = /^(sukses|success|paid|settlement|berhasil)$/i.test(status)
  return {
    success: Boolean(body.success ?? true),
    id: String(body.id || id),
    status,
    paid,
    raw: body,
  }
}
