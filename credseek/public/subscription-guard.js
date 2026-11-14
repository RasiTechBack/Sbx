/**
 * Injected into the SPA shell:
 * - unpaid members → /subscribe (admin/dev bypass via API)
 * - admins get a Billing & Trial shortcut so the page is discoverable
 */
(function () {
  const token = localStorage.getItem('credseek_token') || localStorage.getItem('token') || ''
  if (!token) return
  const path = location.pathname || '/'
  const publicBilling =
    path.startsWith('/subscribe') ||
    path.startsWith('/docs') ||
    path.startsWith('/admin/billing') ||
    path.startsWith('/admin-billing') ||
    path.startsWith('/login') ||
    path.startsWith('/register')

  function injectAdminBillingLink(user) {
    if (!user || user.role !== 'admin') return
    if (document.getElementById('cs-billing-shortcut')) return
    const a = document.createElement('a')
    a.id = 'cs-billing-shortcut'
    a.href = '/admin/billing'
    a.textContent = 'Billing & Trial'
    a.title = 'Buat akun trial & aktivasi langganan'
    a.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:9999;padding:10px 12px;border-radius:10px;' +
      'background:#0d1822;border:1px solid rgba(125,211,252,.35);color:#7dd3fc;font:600 12px/1.2 system-ui,sans-serif;' +
      'text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.35)'
    document.body.appendChild(a)
  }

  fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const user = data && (data.user || data)
      injectAdminBillingLink(user)
    })
    .catch(() => {})

  if (publicBilling) return

  fetch('/api/subscription/me', {
    headers: { Authorization: 'Bearer ' + token },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.subscription) return
      if (data.subscription.active) return
      const next = '/subscribe?from=' + encodeURIComponent(path)
      if (location.pathname !== '/subscribe') location.replace(next)
    })
    .catch(() => {})
})()
