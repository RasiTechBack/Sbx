import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function envBool(name: string, fallback = false) {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'credseek-dev-secret-change-me',
  isProd: process.env.NODE_ENV === 'production',
  requireJwtSecret: envBool('REQUIRE_JWT_SECRET', process.env.NODE_ENV === 'production'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  inviteOnlyRegister: envBool('INVITE_ONLY_REGISTER', false),
  registerInviteCode: process.env.REGISTER_INVITE_CODE || '',
  /** B2B signup notifications land here for RasiTech ops review. */
  supportEmail: process.env.SUPPORT_EMAIL || 'support@rasitech.org',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: envBool('SMTP_SECURE', false),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || 'support@rasitech.org',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  openSearchUrl: process.env.OPENSEARCH_URL || 'http://127.0.0.1:9200',
  openSearchUser: process.env.OPENSEARCH_USER || '',
  openSearchPassword: process.env.OPENSEARCH_PASSWORD || '',
  openSearchIndex: process.env.OPENSEARCH_INDEX || 'credentials',
  searchBackend: (process.env.SEARCH_BACKEND || 'sqlite') as 'sqlite' | 'opensearch',
  minioEndpoint: process.env.MINIO_ENDPOINT || '',
  minioAccessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  minioSecretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  minioBucket: process.env.MINIO_BUCKET || 'credseek-imports',
  importStagingDir:
    process.env.IMPORT_STAGING_DIR || path.join(__dirname, 'data', 'import-staging'),
  dataDir: path.join(__dirname, 'data'),
  usersJsonPath: path.join(__dirname, 'data', 'users.json'),
  /**
   * Soft ceiling for SQLite on-disk size (records.db + WAL/SHM).
   * When reached, all import paths pause until data is deleted or the limit raised.
   * Override with MAX_DB_GB (e.g. 70) or MAX_DB_BYTES.
   */
  maxDbBytes: (() => {
    const rawBytes = Number(process.env.MAX_DB_BYTES || '')
    if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.floor(rawBytes)
    const rawGb = Number(process.env.MAX_DB_GB || '70')
    const gb = Number.isFinite(rawGb) && rawGb > 0 ? rawGb : 70
    return Math.floor(gb * 1024 * 1024 * 1024)
  })(),
}

export function assertProdSecrets() {
  if (!config.requireJwtSecret) return
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'credseek-dev-secret-change-me') {
    throw new Error('JWT_SECRET must be set to a strong value in production')
  }
}
