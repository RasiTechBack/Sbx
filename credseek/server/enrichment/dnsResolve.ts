import dns from 'node:dns/promises'

function isPrivateIpv4(ip: string) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return true
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export type DnsResolveResult = {
  domainLc: string
  ipv4: string[]
  status: 'ok' | 'nx' | 'error' | 'skipped'
}

export async function resolveDomainIpv4(domainLc: string): Promise<DnsResolveResult> {
  const host = String(domainLc || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
  if (!host || host.includes('/') || host.includes(':') || host.includes(' ')) {
    return { domainLc: host, ipv4: [], status: 'skipped' }
  }
  // Already an IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return {
      domainLc: host,
      ipv4: isPrivateIpv4(host) ? [] : [host],
      status: isPrivateIpv4(host) ? 'skipped' : 'ok',
    }
  }
  try {
    const res = await dns.lookup(host, { all: true, family: 4 })
    const ipv4 = [...new Set(res.map((r) => r.address).filter((ip) => !isPrivateIpv4(ip)))]
    return { domainLc: host, ipv4, status: ipv4.length ? 'ok' : 'nx' }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : ''
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { domainLc: host, ipv4: [], status: 'nx' }
    }
    return { domainLc: host, ipv4: [], status: 'error' }
  }
}
