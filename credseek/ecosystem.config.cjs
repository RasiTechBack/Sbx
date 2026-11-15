/** PM2 process file for CredSeek (3–4GB VPS tuned). */
const fs = require('fs')
const path = require('path')

function loadDotEnv(filePath) {
  const out = {}
  try {
    if (!fs.existsSync(filePath)) return out
    for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      out[key] = val
    }
  } catch {
    /* ignore */
  }
  return out
}

const cwd = path.resolve(__dirname)
const fileEnv = {
  ...loadDotEnv(path.join(cwd, '.env')),
  ...loadDotEnv(path.join(cwd, '.env.production')),
}

module.exports = {
  apps: [
    {
      name: 'credseek',
      script: 'npm',
      args: 'start',
      cwd,
      instances: 1,
      exec_mode: 'fork',
      // Host has ~3.8GiB — restart before Linux OOM-killer freezes the box.
      max_memory_restart: fileEnv.PM2_MAX_MEMORY || process.env.PM2_MAX_MEMORY || '1400M',
      exp_backoff_restart_delay: 2000,
      min_uptime: '15s',
      max_restarts: 40,
      kill_timeout: 12000,
      listen_timeout: 60000,
      env: {
        ...fileEnv,
        NODE_ENV: 'production',
        // Cap V8 heap so Node exits cleanly instead of thrashing swap.
        NODE_OPTIONS:
          fileEnv.NODE_OPTIONS || process.env.NODE_OPTIONS || '--max-old-space-size=1280',
        GUARD_MAX_RSS_MB: fileEnv.GUARD_MAX_RSS_MB || '1500',
        GUARD_MAX_HEAP_MB: fileEnv.GUARD_MAX_HEAP_MB || '1200',
        // Bulk TG/import can stall the loop for several seconds — don't suicide mid-download.
        GUARD_MAX_LOOP_MS: fileEnv.GUARD_MAX_LOOP_MS || '20000',
        GUARD_LOOP_STRIKES: fileEnv.GUARD_LOOP_STRIKES || '8',
      },
    },
    {
      name: 'credseek-guard',
      script: 'npm',
      args: 'run guard',
      cwd,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '120M',
      autorestart: true,
      exp_backoff_restart_delay: 3000,
      min_uptime: '5s',
      env: {
        ...fileEnv,
        NODE_ENV: 'production',
        GUARD_APP_NAME: 'credseek',
        GUARD_HEALTH_URL: 'http://127.0.0.1:3001/api/health',
        GUARD_WATCH_MS: fileEnv.GUARD_WATCH_MS || '30000',
        GUARD_HEALTH_TIMEOUT_MS: fileEnv.GUARD_HEALTH_TIMEOUT_MS || '45000',
        GUARD_FAIL_STREAK: fileEnv.GUARD_FAIL_STREAK || '4',
        GUARD_COOLDOWN_MS: fileEnv.GUARD_COOLDOWN_MS || '180000',
        GUARD_BOOT_GRACE_MS: fileEnv.GUARD_BOOT_GRACE_MS || '180000',
        GUARD_MAX_RSS_MB: fileEnv.GUARD_MAX_RSS_MB || '1600',
        GUARD_MIN_AVAIL_MEM_MB: fileEnv.GUARD_MIN_AVAIL_MEM_MB || '200',
        GUARD_MAX_LOAD: fileEnv.GUARD_MAX_LOAD || '6',
        GUARD_MAX_TEMP_C: fileEnv.GUARD_MAX_TEMP_C || '90',
        PM2_BIN: fileEnv.PM2_BIN || '/usr/bin/pm2',
      },
    },
  ],
}
