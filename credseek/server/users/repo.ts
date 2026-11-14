import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { getPool, hasPostgres } from '../db/postgres.js'
import { cacheDel, cacheGet, cacheSet } from '../redis.js'
import { ROLES, type Role, type User } from '../store.js'

const COLORS = ['#0891b2', '#188038', '#c5221f', '#f9ab00', '#0ea5e9', '#00786a']

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    passwordHash: String(row.password_hash ?? ''),
    role: ROLES.includes(row.role as Role) ? (row.role as Role) : 'user',
    avatarColor: String(row.avatar_color ?? '#1a73e8'),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? new Date().toISOString()),
  }
}

function readJsonUsers(): User[] {
  if (!fs.existsSync(config.usersJsonPath)) return []
  const list = JSON.parse(fs.readFileSync(config.usersJsonPath, 'utf8')) as Partial<User>[]
  return list.map((u) => ({
    id: u.id || randomUUID(),
    name: u.name || '',
    email: (u.email || '').toLowerCase(),
    passwordHash: u.passwordHash || '',
    role: ROLES.includes(u.role as Role) ? (u.role as Role) : 'user',
    avatarColor: u.avatarColor || '#1a73e8',
    createdAt: u.createdAt || new Date().toISOString(),
  }))
}

function writeJsonUsers(users: User[]) {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(config.usersJsonPath, JSON.stringify(users, null, 2), 'utf8')
}

function userCacheKey(id: string) {
  return `user:${id}`
}

export async function migrateUsersJsonToPostgres() {
  if (!hasPostgres()) return { migrated: false, count: 0 }
  const existing = await getPool().query<{ c: string }>('SELECT COUNT(*)::text AS c FROM users')
  if (Number(existing.rows[0]?.c || 0) > 0) {
    return { migrated: false, count: Number(existing.rows[0]?.c || 0) }
  }
  const jsonUsers = readJsonUsers()
  if (!jsonUsers.length) return { migrated: false, count: 0 }

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    for (const u of jsonUsers) {
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, avatar_color, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO NOTHING`,
        [u.id, u.name, u.email, u.passwordHash, u.role, u.avatarColor, u.createdAt],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { migrated: true, count: jsonUsers.length }
}

export async function findUserById(id: string): Promise<User | null> {
  const cached = await cacheGet(userCacheKey(id))
  if (cached) {
    try {
      return JSON.parse(cached) as User
    } catch {
      /* ignore */
    }
  }

  let user: User | null = null
  if (hasPostgres()) {
    const res = await getPool().query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id])
    user = res.rows[0] ? rowToUser(res.rows[0]) : null
  } else {
    user = readJsonUsers().find((u) => u.id === id) || null
  }

  if (user) await cacheSet(userCacheKey(id), JSON.stringify(user), 60)
  return user
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const normalized = email.trim().toLowerCase()
  if (hasPostgres()) {
    const res = await getPool().query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [
      normalized,
    ])
    return res.rows[0] ? rowToUser(res.rows[0]) : null
  }
  return readJsonUsers().find((u) => u.email === normalized) || null
}

export async function createUser(input: {
  name: string
  email: string
  passwordHash: string
  role?: Role
  id?: string
}): Promise<User> {
  const role: Role =
    input.role === 'admin' || input.role === 'dev' || input.role === 'user' ? input.role : 'user'
  const user: User = {
    id: input.id || randomUUID(),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    passwordHash: input.passwordHash,
    role,
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    createdAt: new Date().toISOString(),
  }

  if (hasPostgres()) {
    await getPool().query(
      `INSERT INTO users (id, name, email, password_hash, role, avatar_color, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.id, user.name, user.email, user.passwordHash, user.role, user.avatarColor, user.createdAt],
    )
  } else {
    const users = readJsonUsers()
    if (users.some((u) => u.email === user.email)) {
      const err = new Error('EMAIL_TAKEN')
      throw err
    }
    users.push(user)
    writeJsonUsers(users)
  }

  await cacheSet(userCacheKey(user.id), JSON.stringify(user), 60)
  return user
}

export async function updateUser(user: User): Promise<User> {
  if (hasPostgres()) {
    await getPool().query(
      `UPDATE users SET name=$2, email=$3, password_hash=$4, role=$5, avatar_color=$6
       WHERE id=$1`,
      [user.id, user.name, user.email, user.passwordHash, user.role, user.avatarColor],
    )
  } else {
    const users = readJsonUsers()
    const idx = users.findIndex((u) => u.id === user.id)
    if (idx < 0) throw new Error('NOT_FOUND')
    users[idx] = user
    writeJsonUsers(users)
  }
  await cacheSet(userCacheKey(user.id), JSON.stringify(user), 60)
  return user
}

export async function deleteUser(id: string): Promise<User | null> {
  const existing = await findUserById(id)
  if (!existing) return null
  if (hasPostgres()) {
    await getPool().query('DELETE FROM users WHERE id = $1', [id])
  } else {
    writeJsonUsers(readJsonUsers().filter((u) => u.id !== id))
  }
  await cacheDel(userCacheKey(id))
  return existing
}

export async function countAdmins(): Promise<number> {
  if (hasPostgres()) {
    const res = await getPool().query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users WHERE role = 'admin'`,
    )
    return Number(res.rows[0]?.c || 0)
  }
  return readJsonUsers().filter((u) => u.role === 'admin').length
}

export async function countUsers(): Promise<number> {
  if (hasPostgres()) {
    const res = await getPool().query<{ c: string }>('SELECT COUNT(*)::text AS c FROM users')
    return Number(res.rows[0]?.c || 0)
  }
  return readJsonUsers().length
}

export async function listUsersPaged(opts: {
  q?: string
  page?: number
  limit?: number
}): Promise<{ users: User[]; total: number; page: number; limit: number; hasMore: boolean }> {
  const page = Math.max(1, opts.page || 1)
  const limit = Math.min(100, Math.max(1, opts.limit || 25))
  const offset = (page - 1) * limit
  const q = (opts.q || '').trim().toLowerCase()

  if (hasPostgres()) {
    const params: unknown[] = []
    let where = ''
    if (q) {
      params.push(`%${q}%`)
      where = `WHERE lower(name) LIKE $1 OR lower(email) LIKE $1`
    }
    const countRes = await getPool().query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users ${where}`,
      params,
    )
    const total = Number(countRes.rows[0]?.c || 0)
    const listParams = [...params, limit, offset]
    const limIdx = params.length + 1
    const offIdx = params.length + 2
    const listRes = await getPool().query(
      `SELECT * FROM users ${where}
       ORDER BY name ASC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams,
    )
    const users = listRes.rows.map((r) => rowToUser(r))
    return { users, total, page, limit, hasMore: offset + users.length < total }
  }

  let users = readJsonUsers()
  if (q) {
    users = users.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    )
  }
  users.sort((a, b) => a.name.localeCompare(b.name))
  const total = users.length
  const slice = users.slice(offset, offset + limit)
  return { users: slice, total, page, limit, hasMore: offset + slice.length < total }
}

export async function countUsersByRole(): Promise<{ admin: number; dev: number; user: number }> {
  if (hasPostgres()) {
    const res = await getPool().query<{ role: string; c: string }>(
      `SELECT role, COUNT(*)::text AS c FROM users GROUP BY role`,
    )
    const out = { admin: 0, dev: 0, user: 0 }
    for (const row of res.rows) {
      if (row.role === 'admin' || row.role === 'dev' || row.role === 'user') {
        out[row.role] = Number(row.c)
      }
    }
    return out
  }
  const users = readJsonUsers()
  return {
    admin: users.filter((u) => u.role === 'admin').length,
    dev: users.filter((u) => u.role === 'dev').length,
    user: users.filter((u) => u.role === 'user').length,
  }
}
