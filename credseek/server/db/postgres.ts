import pg from 'pg'
import { config } from '../config.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function hasPostgres() {
  return Boolean(config.databaseUrl)
}

export function getPool() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not configured')
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.PG_POOL_MAX) || 20,
      idleTimeoutMillis: 30_000,
    })
  }
  return pool
}

export async function initPostgres() {
  if (!hasPostgres()) return { enabled: false as const }

  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'dev', 'user')),
      avatar_color TEXT NOT NULL DEFAULT '#1a73e8',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
    CREATE INDEX IF NOT EXISTS users_name_trgm_ready_idx ON users (name);
    CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
    CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id UUID PRIMARY KEY,
      user_id UUID,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS import_jobs_status_idx ON import_jobs (status, created_at);
  `)

  return { enabled: true as const }
}

export async function closePostgres() {
  if (pool) {
    await pool.end()
    pool = null
  }
}
