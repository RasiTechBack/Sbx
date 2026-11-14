import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, 'data')
const usersPath = path.join(dataDir, 'users.json')

export type Role = 'dev' | 'admin' | 'user'

export type User = {
  id: string
  name: string
  email: string
  passwordHash: string
  role: Role
  avatarColor: string
  createdAt: string
}

export type RecordItem = {
  id: string
  isi: string
  database: string
  url: string
  username: string
  password: string
  raw: string
  importedAt: string
}

export const ROLES: Role[] = ['dev', 'admin', 'user']

export function canManageData(role: Role | undefined) {
  return role === 'admin' || role === 'dev'
}

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  if (!fs.existsSync(usersPath)) {
    fs.writeFileSync(usersPath, '[]', 'utf8')
  }
}

function normalizeUser(raw: Partial<User> & { email: string }): User {
  return {
    id: raw.id || '',
    name: raw.name || '',
    email: raw.email,
    passwordHash: raw.passwordHash || '',
    role: ROLES.includes(raw.role as Role) ? (raw.role as Role) : 'user',
    avatarColor: raw.avatarColor || '#1a73e8',
    createdAt: raw.createdAt || new Date().toISOString(),
  }
}

ensureStore()

export function readUsers(): User[] {
  ensureStore()
  const list = JSON.parse(fs.readFileSync(usersPath, 'utf8')) as Partial<User>[]
  return list.map((u) => normalizeUser(u as User))
}

export function writeUsers(users: User[]) {
  ensureStore()
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8')
}

/** Stable key for duplicate detection (ignores raw formatting differences). */
export function credentialDedupeKey(item: {
  url: string
  username: string
  password: string
}) {
  const url = item.url.trim().replace(/\/+$/, '').toLowerCase()
  const username = item.username.trim().toLowerCase()
  const password = item.password.trim()
  return `${url}\0${username}\0${password}`
}

/**
 * Parse credential lines.
 * Supported:
 * - URL:USERNAME:PASSWORD   e.g. https://namaa.cc/ass:userrr:1234566
 * - ISI DATABASE URL:USERNAME:PASSWORD
 */
export function parseCredentialLine(line: string): Omit<RecordItem, 'id' | 'importedAt'> | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const parts = trimmed.split(':')
  if (parts.length < 3) return null

  const password = parts[parts.length - 1]?.trim() ?? ''
  const username = parts[parts.length - 2]?.trim() ?? ''
  const head = parts.slice(0, -2).join(':').trim()

  if (!head || !username) return null

  let isi = ''
  let database = ''
  let url = head

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(head) || head.startsWith('//') || /^[\w.-]+(:\d+)?(\/|$)/.test(head)) {
    url = head
  } else {
    const headParts = head.split(/\s+/)
    if (headParts.length >= 3) {
      isi = headParts[0] ?? ''
      database = headParts[1] ?? ''
      url = headParts.slice(2).join(' ')
    } else if (headParts.length === 2) {
      isi = headParts[0] ?? ''
      url = headParts[1] ?? ''
    } else {
      url = head
    }
  }

  if (!url || !username) return null

  return {
    isi,
    database,
    url,
    username,
    password,
    raw: trimmed,
  }
}
