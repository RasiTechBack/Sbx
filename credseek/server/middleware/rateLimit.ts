import type express from 'express'
import { rateLimit } from '../redis.js'

type Authish = express.Request & { user?: { id: string } }

function clientKey(req: express.Request) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim()
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function rateLimitMiddleware(opts: {
  name: string
  limit: number
  windowSec: number
  byUser?: boolean
}) {
  return async (req: Authish, res: express.Response, next: express.NextFunction) => {
    const id = opts.byUser && req.user?.id ? `u:${req.user.id}` : `ip:${clientKey(req)}`
    const result = await rateLimit({
      key: `${opts.name}:${id}`,
      limit: opts.limit,
      windowSec: opts.windowSec,
    })
    res.setHeader('X-RateLimit-Limit', String(opts.limit))
    res.setHeader('X-RateLimit-Remaining', String(result.remaining))
    res.setHeader('X-RateLimit-Reset', String(result.resetSec))
    if (!result.ok) {
      return res.status(429).json({
        error: 'Terlalu banyak permintaan. Coba lagi sebentar.',
        retryAfterSec: result.resetSec,
      })
    }
    next()
  }
}
