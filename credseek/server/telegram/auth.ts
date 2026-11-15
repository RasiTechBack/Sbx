import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { TelegramClient, Api } from 'teleproto'
import { StringSession } from 'teleproto/sessions'
import { AuthKey } from 'teleproto/crypto/AuthKey.js'
import { readTelegramConfig } from '../importers/fetchRemote.js'
import './tlCompat.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sessionsPath = path.join(__dirname, '..', 'data', 'telegram-sessions.json')

export type LinkedTelegramAccount = {
  id: string
  apiId: number
  apiHash: string
  session: string
  telegramUser: {
    id: string
    username?: string
    firstName?: string
    lastName?: string
    phone?: string
  }
  linkedAt: string
  lastTestedAt?: string
  lastTestOk?: boolean
}

export type PublicTelegramAccount = {
  id: string
  linked: true
  linkedAt: string
  lastTestedAt?: string
  lastTestOk?: boolean
  telegramUser: LinkedTelegramAccount['telegramUser']
}

/** Legacy single-account row or new multi-account bag. */
type UserSessionBag =
  | LinkedTelegramAccount
  | {
      accounts: LinkedTelegramAccount[]
    }

type SessionStore = Record<string, UserSessionBag>

type PendingLogin = {
  id: string
  userId: string
  apiId: number
  apiHash: string
  phone: string
  phoneCodeHash: string
  client: TelegramClient
  createdAt: number
}

const pending = new Map<string, PendingLogin>()
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_ACCOUNTS_PER_USER = 50

function readStore(): SessionStore {
  try {
    if (!fs.existsSync(sessionsPath)) return {}
    return JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) as SessionStore
  } catch {
    return {}
  }
}

function writeStore(store: SessionStore) {
  fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2), 'utf8')
}

function toPublicAccount(row: LinkedTelegramAccount): PublicTelegramAccount {
  return {
    id: row.id,
    linked: true,
    linkedAt: row.linkedAt,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    telegramUser: row.telegramUser,
  }
}

function normalizeAccounts(raw: UserSessionBag | undefined): LinkedTelegramAccount[] {
  if (!raw) return []
  if ('accounts' in raw && Array.isArray(raw.accounts)) {
    return raw.accounts
      .filter((a) => a && typeof a === 'object' && a.session)
      .map((a) => ({
        ...a,
        id: a.id || randomUUID(),
      }))
  }
  // Legacy: one account object keyed by CredSeek userId
  if ('session' in raw && raw.session) {
    const legacy = raw as LinkedTelegramAccount
    return [
      {
        ...legacy,
        id: legacy.id || legacy.telegramUser?.id || randomUUID(),
      },
    ]
  }
  return []
}

function listRawAccounts(userId: string): LinkedTelegramAccount[] {
  return normalizeAccounts(readStore()[userId])
}

function saveUserAccounts(userId: string, accounts: LinkedTelegramAccount[]) {
  const store = readStore()
  if (!accounts.length) {
    delete store[userId]
  } else {
    store[userId] = { accounts }
  }
  writeStore(store)
}

function cleanupPending() {
  const now = Date.now()
  for (const [id, item] of pending) {
    if (now - item.createdAt > PENDING_TTL_MS) {
      void item.client.disconnect().catch(() => undefined)
      pending.delete(id)
    }
  }
}

export function listLinkedTelegramAccounts(userId: string): PublicTelegramAccount[] {
  return listRawAccounts(userId).map(toPublicAccount)
}

/** All personal sessions across CredSeek users (for monitor fallback when no bot token). */
export function listAllLinkedAccountRows(): Array<{
  ownerUserId: string
  account: LinkedTelegramAccount
}> {
  const store = readStore()
  const out: Array<{ ownerUserId: string; account: LinkedTelegramAccount }> = []
  for (const [ownerUserId, bag] of Object.entries(store)) {
    for (const account of normalizeAccounts(bag)) {
      out.push({ ownerUserId, account })
    }
  }
  return out
}

/**
 * Same StringSession linked under multiple CredSeek users causes AUTH_KEY_DUPLICATED.
 * Prefer one row per session string (and per Telegram user id).
 */
export function listUniqueLinkedAccountRows(preferredUserId?: string): Array<{
  ownerUserId: string
  account: LinkedTelegramAccount
}> {
  const rows = listAllLinkedAccountRows()
  const ordered = [
    ...rows.filter((r) => r.ownerUserId === preferredUserId),
    ...rows.filter((r) => r.ownerUserId !== preferredUserId),
  ]
  const seenSession = new Set<string>()
  const seenTgUser = new Set<string>()
  const out: Array<{ ownerUserId: string; account: LinkedTelegramAccount }> = []
  for (const row of ordered) {
    const sessionKey = String(row.account.session || '').trim()
    const tgId = String(row.account.telegramUser?.id || '').trim()
    if (sessionKey && seenSession.has(sessionKey)) continue
    if (tgId && seenTgUser.has(tgId)) continue
    if (sessionKey) seenSession.add(sessionKey)
    if (tgId) seenTgUser.add(tgId)
    out.push(row)
  }
  return out
}

export function countAllLinkedAccounts() {
  return listAllLinkedAccountRows().length
}

/** Drop every stored copy of a dead StringSession (and matching Telegram user id). */
export function purgeSessionsMatching(input: {
  session?: string
  telegramUserId?: string
}): number {
  const sessionKey = String(input.session || '').trim()
  const tgId = String(input.telegramUserId || '').trim()
  if (!sessionKey && !tgId) return 0

  const store = readStore()
  let removed = 0
  for (const [ownerUserId, bag] of Object.entries(store)) {
    const accounts = normalizeAccounts(bag)
    const next = accounts.filter((a) => {
      const hitSession = sessionKey && a.session === sessionKey
      const hitUser = tgId && String(a.telegramUser?.id || '') === tgId
      if (hitSession || hitUser) {
        removed += 1
        return false
      }
      return true
    })
    if (next.length !== accounts.length) {
      if (!next.length) delete store[ownerUserId]
      else store[ownerUserId] = { accounts: next }
    }
  }
  if (removed) writeStore(store)
  return removed
}

function assertSessionNotShared(userId: string, session: string, telegramUserId: string) {
  const sessionKey = session.trim()
  const tgId = telegramUserId.trim()
  for (const row of listAllLinkedAccountRows()) {
    if (row.ownerUserId === userId) continue
    const sameSession = sessionKey && row.account.session === sessionKey
    const sameUser = tgId && String(row.account.telegramUser?.id || '') === tgId
    if (sameSession || sameUser) {
      throw new Error(
        'Session Telegram ini sudah terhubung di akun CredSeek lain. Unlink di akun itu dulu — pakai session yang sama di 2 tempat memicu AUTH_KEY_DUPLICATED.',
      )
    }
  }
}

/** @deprecated Prefer listLinkedTelegramAccounts — returns the first linked account. */
export function getLinkedTelegram(userId: string) {
  const accounts = listLinkedTelegramAccounts(userId)
  return accounts[0] || null
}

export function unlinkTelegram(userId: string, accountId?: string) {
  if (!accountId) {
    const store = readStore()
    delete store[userId]
    writeStore(store)
    return { removed: true, remaining: 0 }
  }
  const current = listRawAccounts(userId)
  const next = current.filter((a) => a.id !== accountId)
  if (next.length === current.length) {
    throw new Error('Akun Telegram tidak ditemukan')
  }
  saveUserAccounts(userId, next)
  return { removed: true, remaining: next.length }
}

export async function startTelegramLogin(input: {
  userId: string
  apiId?: number | string
  apiHash?: string
  phone: string
}) {
  cleanupPending()
  const phone = input.phone.trim()
  if (!phone) throw new Error('Nomor telepon wajib diisi')
  const { apiId, apiHash } = resolveApiCredentials({
    apiId: input.apiId,
    apiHash: input.apiHash,
  })

  // disconnect any previous pending for same user
  for (const [id, item] of pending) {
    if (item.userId === input.userId) {
      void item.client.disconnect().catch(() => undefined)
      pending.delete(id)
    }
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
  })
  await client.connect()

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    }),
  )

  const phoneCodeHash =
    'phoneCodeHash' in result ? String((result as { phoneCodeHash: string }).phoneCodeHash) : ''
  if (!phoneCodeHash) {
    await client.disconnect()
    throw new Error('Gagal mengirim kode Telegram')
  }

  const id = randomUUID()
  pending.set(id, {
    id,
    userId: input.userId,
    apiId,
    apiHash,
    phone,
    phoneCodeHash,
    client,
    createdAt: Date.now(),
  })

  return {
    loginId: id,
    phone,
    message: 'Kode verifikasi dikirim ke aplikasi Telegram Anda',
  }
}

async function persistClientSession(
  userId: string,
  apiId: number,
  apiHash: string,
  client: TelegramClient,
) {
  const me = await client.getMe()
  if (!me || typeof me !== 'object' || !('id' in me)) {
    throw new Error('Gagal membaca profil Telegram')
  }

  const session = client.session.save() as unknown as string
  const telegramUser = {
    id: String(me.id),
    username: 'username' in me && me.username ? String(me.username) : undefined,
    firstName: 'firstName' in me && me.firstName ? String(me.firstName) : undefined,
    lastName: 'lastName' in me && me.lastName ? String(me.lastName) : undefined,
    phone: 'phone' in me && me.phone ? String(me.phone) : undefined,
  }

  assertSessionNotShared(userId, session, telegramUser.id)

  const accounts = listRawAccounts(userId)
  const existingIdx = accounts.findIndex((a) => a.telegramUser?.id === telegramUser.id)
  const now = new Date().toISOString()
  const nextRow: LinkedTelegramAccount = {
    id: existingIdx >= 0 ? accounts[existingIdx]!.id : randomUUID(),
    apiId,
    apiHash,
    session,
    telegramUser,
    linkedAt: existingIdx >= 0 ? accounts[existingIdx]!.linkedAt : now,
    lastTestedAt: now,
    lastTestOk: true,
  }

  if (existingIdx >= 0) {
    accounts[existingIdx] = nextRow
  } else {
    if (accounts.length >= MAX_ACCOUNTS_PER_USER) {
      await client.disconnect().catch(() => undefined)
      throw new Error(`Maksimal ${MAX_ACCOUNTS_PER_USER} akun Telegram per user`)
    }
    accounts.push(nextRow)
  }

  saveUserAccounts(userId, accounts)
  await client.disconnect()
  return toPublicAccount(nextRow)
}

export async function confirmTelegramCode(input: {
  userId: string
  loginId: string
  code: string
}) {
  cleanupPending()
  const item = pending.get(input.loginId)
  if (!item || item.userId !== input.userId) {
    throw new Error('Sesi login tidak ditemukan / kedaluwarsa. Mulai ulang.')
  }

  try {
    await item.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: item.phone,
        phoneCodeHash: item.phoneCodeHash,
        phoneCode: input.code.trim(),
      }),
    )
    pending.delete(input.loginId)
    return {
      needPassword: false as const,
      account: await persistClientSession(item.userId, item.apiId, item.apiHash, item.client),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const errObj = err as { errorMessage?: string; code?: number }
    const rpc = `${errObj.errorMessage || ''} ${message}`
    if (rpc.includes('SESSION_PASSWORD_NEEDED') || rpc.toLowerCase().includes('2fa')) {
      return { needPassword: true as const, loginId: item.id }
    }
    throw new Error(rpc.includes('PHONE_CODE') ? 'Kode verifikasi salah / kedaluwarsa' : message)
  }
}

export async function confirmTelegramPassword(input: {
  userId: string
  loginId: string
  password: string
}) {
  cleanupPending()
  const item = pending.get(input.loginId)
  if (!item || item.userId !== input.userId) {
    throw new Error('Sesi login tidak ditemukan / kedaluwarsa. Mulai ulang.')
  }

  const { computeCheck } = await import('teleproto/Password.js')
  const passwordInfo = await item.client.invoke(new Api.account.GetPassword())
  const password = await computeCheck(passwordInfo, input.password)
  await item.client.invoke(new Api.auth.CheckPassword({ password }))
  pending.delete(input.loginId)
  return {
    needPassword: false as const,
    account: await persistClientSession(item.userId, item.apiId, item.apiHash, item.client),
  }
}

function resolveApiCredentials(input: { apiId?: number | string; apiHash?: string }) {
  const cfg = readTelegramConfig()
  const apiIdRaw = input.apiId !== undefined && String(input.apiId).trim() !== ''
    ? Number(input.apiId)
    : cfg.apiId
  const apiId = apiIdRaw && Number.isFinite(apiIdRaw) ? Number(apiIdRaw) : 0
  const apiHash =
    input.apiHash !== undefined && String(input.apiHash).trim() !== ''
      ? String(input.apiHash).trim()
      : cfg.apiHash?.trim() || ''
  if (!apiId || !apiHash) {
    throw new Error('api_id dan api_hash wajib (isi form atau simpan dulu di Settings → Telegram bot)')
  }
  return { apiId, apiHash }
}

/** Convert Telethon/Pyrogram SQLite `.session` bytes into a GramJS StringSession. */
export async function telethonSessionToStringSession(sessionBytes: Buffer) {
  if (!sessionBytes?.length) throw new Error('File session kosong')

  const tmp = path.join(os.tmpdir(), `credseek-tg-${randomUUID()}.session`)
  fs.writeFileSync(tmp, sessionBytes)
  try {
    const db = new DatabaseSync(tmp, { readOnly: true })
    try {
      const row = db
        .prepare('SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1')
        .get() as
        | { dc_id: number; server_address: string; port: number; auth_key: Buffer | Uint8Array }
        | undefined
      if (!row?.auth_key) {
        throw new Error('File bukan Telethon/Pyrogram .session yang valid (auth_key tidak ada)')
      }
      const authKeyBuf = Buffer.from(row.auth_key)
      if (authKeyBuf.length !== 256) {
        throw new Error(`auth_key tidak valid (panjang ${authKeyBuf.length}, diharapkan 256)`)
      }

      const session = new StringSession('')
      session.setDC(Number(row.dc_id), String(row.server_address), Number(row.port))
      const key = new AuthKey()
      await key.setKey(authKeyBuf)
      session.setAuthKey(key)
      const saved = session.save()
      if (!saved) throw new Error('Gagal membangun StringSession dari file')
      return saved
    } finally {
      db.close()
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function mapTelegramSessionImportError(err: unknown, kind: 'file' | 'string'): Error {
  const message = err instanceof Error ? err.message : String(err || '')
  const code =
    err && typeof err === 'object' && 'errorMessage' in err
      ? String((err as { errorMessage?: string }).errorMessage || '')
      : ''
  const blob = `${code} ${message}`
  if (/AUTH_KEY_DUPLICATED|AuthKeyDuplicated|Concurrent usage/i.test(blob)) {
    return new Error(
      'Session ini sudah mati (AUTH_KEY_DUPLICATED). File/string yang sama tidak bisa dipakai lagi. ' +
        'Tutup semua script/Telethon/Pyrogram yang pakai session itu, lalu buat session BARU ' +
        '(paling aman: Phone OTP di CredSeek), dan jangan pakai session yang sama di 2 tempat.',
    )
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|not authorized|expired/i.test(blob)) {
    return new Error(
      kind === 'file'
        ? 'Session file tidak terotorisasi / sudah expired. Buat session baru.'
        : 'StringSession tidak terotorisasi / sudah expired. Buat session baru.',
    )
  }
  return err instanceof Error ? err : new Error(message || 'Gagal import session Telegram')
}

export async function importTelegramSessionFile(input: {
  userId: string
  sessionBytes: Buffer
  apiId?: number | string
  apiHash?: string
}) {
  const { apiId, apiHash } = resolveApiCredentials(input)
  const stringSession = await telethonSessionToStringSession(input.sessionBytes)

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
    autoReconnect: false,
  })

  try {
    await client.connect()
    if (!(await client.checkAuthorization())) {
      throw new Error('Session file tidak terotorisasi / sudah expired. Minta file session baru.')
    }
    return await persistClientSession(input.userId, apiId, apiHash, client)
  } catch (err) {
    try {
      await client.disconnect()
    } catch {
      /* ignore */
    }
    throw mapTelegramSessionImportError(err, 'file')
  }
}

export async function importTelegramStringSession(input: {
  userId: string
  stringSession: string
  apiId?: number | string
  apiHash?: string
}) {
  const { apiId, apiHash } = resolveApiCredentials(input)
  const raw = input.stringSession.trim()
  if (!raw || raw[0] !== '1') {
    throw new Error('StringSession tidak valid (harus mulai dengan versi "1")')
  }

  const client = new TelegramClient(new StringSession(raw), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
    autoReconnect: false,
  })

  try {
    await client.connect()
    if (!(await client.checkAuthorization())) {
      throw new Error('StringSession tidak terotorisasi / sudah expired')
    }
    return await persistClientSession(input.userId, apiId, apiHash, client)
  } catch (err) {
    try {
      await client.disconnect()
    } catch {
      /* ignore */
    }
    throw mapTelegramSessionImportError(err, 'string')
  }
}

export async function withUserTelegramClient<T>(
  userId: string,
  fn: (client: TelegramClient) => Promise<T>,
  accountId?: string,
) {
  const accounts = listRawAccounts(userId)
  if (!accounts.length) throw new Error('Akun Telegram belum terhubung')
  const row = accountId ? accounts.find((a) => a.id === accountId) : accounts[0]
  if (!row) throw new Error('Akun Telegram tidak ditemukan')

  const client = new TelegramClient(new StringSession(row.session), row.apiId, row.apiHash, {
    connectionRetries: 3,
    useWSS: false,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

export async function testTelegramAccount(userId: string, accountId: string) {
  const accounts = listRawAccounts(userId)
  const idx = accounts.findIndex((a) => a.id === accountId)
  if (idx < 0) throw new Error('Akun Telegram tidak ditemukan')
  const row = accounts[idx]!

  const client = new TelegramClient(new StringSession(row.session), row.apiId, row.apiHash, {
    connectionRetries: 3,
    useWSS: false,
  })

  try {
    await client.connect()
    if (!(await client.checkAuthorization())) {
      throw new Error('Session tidak terotorisasi / sudah expired')
    }
    const me = await client.getMe()
    if (!me || typeof me !== 'object' || !('id' in me)) {
      throw new Error('Gagal membaca profil Telegram')
    }
    const telegramUser = {
      id: String(me.id),
      username: 'username' in me && me.username ? String(me.username) : undefined,
      firstName: 'firstName' in me && me.firstName ? String(me.firstName) : undefined,
      lastName: 'lastName' in me && me.lastName ? String(me.lastName) : undefined,
      phone: 'phone' in me && me.phone ? String(me.phone) : undefined,
    }
    const now = new Date().toISOString()
    accounts[idx] = {
      ...row,
      telegramUser,
      lastTestedAt: now,
      lastTestOk: true,
    }
    saveUserAccounts(userId, accounts)
    return {
      ok: true as const,
      account: toPublicAccount(accounts[idx]!),
    }
  } catch (err) {
    const now = new Date().toISOString()
    accounts[idx] = {
      ...row,
      lastTestedAt: now,
      lastTestOk: false,
    }
    saveUserAccounts(userId, accounts)
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

export async function testAllTelegramAccounts(userId: string) {
  const accounts = listRawAccounts(userId)
  if (!accounts.length) throw new Error('Belum ada akun Telegram yang terhubung')
  const results: Array<{
    id: string
    ok: boolean
    error?: string
    account?: PublicTelegramAccount
  }> = []
  for (const row of accounts) {
    try {
      const res = await testTelegramAccount(userId, row.id)
      results.push({ id: row.id, ok: true, account: res.account })
    } catch (err) {
      results.push({
        id: row.id,
        ok: false,
        error: err instanceof Error ? err.message : 'Test gagal',
        account: listLinkedTelegramAccounts(userId).find((a) => a.id === row.id),
      })
    }
  }
  return {
    ok: results.every((r) => r.ok),
    tested: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
}

export async function fetchTelegramMessageTextWithUser(userId: string, rawUrl: string) {
  const url = new URL(rawUrl)
  const parts = url.pathname.split('/').filter(Boolean)
  let username: string | undefined
  let chatId: string | undefined
  let messageId: number | undefined

  if (parts[0] === 's') {
    username = parts[1]
    messageId = parts[2] ? Number(parts[2]) : undefined
  } else if (parts[0] === 'c') {
    chatId = parts[1] ? `-100${parts[1]}` : undefined
    messageId = parts[2] ? Number(parts[2]) : undefined
  } else {
    username = parts[0]
    messageId = parts[1] ? Number(parts[1]) : undefined
  }

  if (!messageId) {
    throw new Error('Link harus ke post/pesan spesifik')
  }

  const entity = chatId || username
  if (!entity) throw new Error('Link Telegram tidak dikenali')

  const accounts = listRawAccounts(userId)
  if (!accounts.length) throw new Error('Akun Telegram belum terhubung')

  let lastError = 'Tidak bisa membaca pesan dengan akun yang terhubung'
  for (const row of accounts) {
    try {
      return await withUserTelegramClient(
        userId,
        async (client) => {
          const messages = await client.getMessages(entity, { ids: messageId })
          const msg = messages[0]
          const text = msg?.message || ''
          if (!text.trim()) {
            throw new Error('Pesan ditemukan tapi tidak ada teks yang bisa diimport')
          }
          return text
        },
        row.id,
      )
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastError)
}
