/** Common free / consumer mailbox providers — not accepted for B2B signup. */
const FREE_EMAIL_DOMAINS = new Set(
  [
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'yahoo.co.id',
    'yahoo.co.uk',
    'ymail.com',
    'hotmail.com',
    'hotmail.co.uk',
    'outlook.com',
    'outlook.co.id',
    'live.com',
    'msn.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'protonmail.com',
    'proton.me',
    'pm.me',
    'tutanota.com',
    'tutamail.com',
    'gmx.com',
    'gmx.de',
    'mail.com',
    'email.com',
    'yandex.com',
    'yandex.ru',
    'zoho.com',
    'mail.ru',
    'inbox.com',
    'fastmail.com',
    'hey.com',
    'qq.com',
    '163.com',
    '126.com',
  ].map((d) => d.toLowerCase()),
)

export function extractEmailDomain(email: string) {
  const at = email.trim().toLowerCase().lastIndexOf('@')
  if (at < 0) return ''
  return email
    .trim()
    .toLowerCase()
    .slice(at + 1)
    .replace(/\.+$/, '')
}

export function isCompanyEmail(email: string): { ok: true } | { ok: false; error: string } {
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: 'Format email tidak valid' }
  }
  const domain = extractEmailDomain(normalized)
  if (!domain || !domain.includes('.')) {
    return { ok: false, error: 'Domain email tidak valid' }
  }
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    return {
      ok: false,
      error: 'Gunakan email perusahaan (bukan Gmail/Yahoo/Outlook pribadi)',
    }
  }
  // Block obvious disposable patterns
  if (
    /^(tempmail|mailinator|guerrillamail|10minutemail|trashmail|yopmail)\./i.test(domain) ||
    /(^|\.)(temp|trash|fake|disposable)mail\./i.test(domain)
  ) {
    return { ok: false, error: 'Email disposable tidak diterima' }
  }
  return { ok: true }
}
