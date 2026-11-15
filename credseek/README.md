# CredSeek

Pencarian kredensial bergaya search engine untuk data format:

```text
URL:USERNAME:PASSWORD
```

Cari akses database dan kredensial infrastruktur dengan cepat.

## Jalankan

```bash
npm install
npm run seed
npm run seed:users
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3001

Akun demo: `admin@credseek.local` / `admin123`

## Big-data (SQLite-first)

Designed for multi-million rows on a single VPS (comfort ~10–50M). Stack: SQLite WAL + FTS5 trigram.

- Search: min **3** chars/token; no `LIKE %…%` full scans; page depth capped (`MAX_SEARCH_OFFSET`).
- FTS v3: indexes `url` / `username` / `password` / `domain` only (no concatenated `hay`).
- Import: chunked transactions (~5k rows) + `busy_timeout`.
- Dashboard: stats cached in `meta` (~5 min TTL); distinct-host count not on every request.
- Export Excel/TXT capped at **100k** rows (keyset/rowid iteration). Prefer `?format=txt` for large dumps.
- Maintenance (admin/dev): `POST /api/maintenance/optimize`

## Public / billion-scale path

Target stack (see `docker-compose.yml` + `.env.example`):

| Layer | Tech |
|-------|------|
| Users / jobs | PostgreSQL (`DATABASE_URL`) |
| Rate limit / queue | Redis (`REDIS_URL`) |
| Credential search | OpenSearch (`SEARCH_BACKEND=opensearch`) |
| Async import | `npm run worker:import` + `/api/import/bulk-async` |
| Process model | `ecosystem.config.cjs` (API + import workers) |

```bash
cp .env.example .env   # set JWT_SECRET, passwords
npm run stack:up       # postgres + redis + opensearch + minio
npm run seed:users
npm run migrate:opensearch   # after pointing SEARCH_BACKEND=opensearch
pm2 start ecosystem.config.cjs
```

Without Docker env vars, API falls back to `users.json` + SQLite (current VPS mode). Accounts UI supports search + pagination. Health: `GET /api/health` reports backend + postgres/redis flags. Backup helper: `scripts/backup.sh`.

### Ops notes

- Deploy updates must **not** overwrite `server/data/records.db*` (see `scripts/update_remote.py`).
- Keep free disk ≈ **2–3×** DB size before FTS rebuild (schema upgrade).
- Do not `VACUUM` during peak traffic; run optimize off-peak.
- First boot after FTS v3 upgrade rebuilds the index once — expect CPU/IO spike on large corpora.
- Production requires strong `JWT_SECRET` when `REQUIRE_JWT_SECRET=true`.
