import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

export type MailPayload = {
  to: string
  subject: string
  text: string
  replyTo?: string
}

/** Persist a copy so ops can audit even if SMTP is down. */
function writeOutbox(payload: MailPayload, meta: { ok: boolean; error?: string }) {
  const dir = path.join(config.dataDir, 'mail-outbox')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${stamp}-${payload.to.replace(/[^a-z0-9@._-]/gi, '_')}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({ ...payload, ...meta, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  )
}

export async function sendMail(payload: MailPayload): Promise<{ ok: boolean; error?: string }> {
  const host = config.smtpHost
  if (!host) {
    const error = 'SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS)'
    writeOutbox(payload, { ok: false, error })
    console.warn(`[mail] ${error} — saved to mail-outbox`)
    return { ok: false, error }
  }

  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth:
        config.smtpUser && config.smtpPass
          ? { user: config.smtpUser, pass: config.smtpPass }
          : undefined,
    })
    await transporter.sendMail({
      from: config.smtpFrom,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      replyTo: payload.replyTo,
    })
    writeOutbox(payload, { ok: true })
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    writeOutbox(payload, { ok: false, error })
    console.error('[mail] send failed:', error)
    return { ok: false, error }
  }
}
