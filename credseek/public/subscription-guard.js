/**
 * Injected into the SPA shell: if the logged-in member has no active plan,
 * bounce them to /subscribe (admin/dev bypass via API).
 */
(function () {
  const token = localStorage.getItem('credseek_token') || localStorage.getItem('token') || ''
  if (!token) return
  const path = location.pathname || '/'
  if (
    path.startsWith('/subscribe') ||
    path.startsWith('/docs') ||
    path.startsWith('/admin/billing') ||
    path.startsWith('/admin-billing') ||
    path.startsWith('/login') ||
    path.startsWith('/register')
  ) {
    return
  }
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
