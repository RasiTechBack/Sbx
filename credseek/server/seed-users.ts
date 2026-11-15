import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { initPostgres, hasPostgres } from './db/postgres.js'
import { createUser, findUserByEmail, migrateUsersJsonToPostgres } from './users/repo.js'
import { readUsers, writeUsers, type User } from './store.js'

const defaults: Array<{ name: string; email: string; password: string; role: User['role'] }> = [
  { name: 'Admin', email: 'admin@credseek.local', password: 'admin123', role: 'admin' },
  { name: 'Developer', email: 'dev@credseek.local', password: 'dev12345', role: 'dev' },
  { name: 'User Demo', email: 'user@credseek.local', password: 'user1234', role: 'user' },
]

async function main() {
  if (hasPostgres()) {
    await initPostgres()
    await migrateUsersJsonToPostgres()
    for (const seed of defaults) {
      if (await findUserByEmail(seed.email)) continue
      await createUser({
        name: seed.name,
        email: seed.email,
        passwordHash: await bcrypt.hash(seed.password, 10),
        role: seed.role,
      })
      console.log(`Created ${seed.role}: ${seed.email} / ${seed.password}`)
    }
    console.log('Users seeded (Postgres)')
    return
  }

  const users = readUsers()
  let changed = false
  for (const seed of defaults) {
    if (users.some((u) => u.email === seed.email)) continue
    users.push({
      id: randomUUID(),
      name: seed.name,
      email: seed.email,
      passwordHash: await bcrypt.hash(seed.password, 10),
      role: seed.role,
      avatarColor: seed.role === 'admin' ? '#c5221f' : seed.role === 'dev' ? '#0891b2' : '#188038',
      createdAt: new Date().toISOString(),
    })
    changed = true
    console.log(`Created ${seed.role}: ${seed.email} / ${seed.password}`)
  }
  if (changed) writeUsers(users)
  console.log(changed ? 'Users updated (JSON)' : 'Users already seeded (JSON)')
}

void main()
