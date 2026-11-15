#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=${BACKUP_DIR:-/opt/credseek/backups}/$STAMP
mkdir -p "$OUT"

if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump "$DATABASE_URL" | gzip > "$OUT/postgres.sql.gz"
fi

if [[ -d /opt/credseek/server/data ]]; then
  tar -C /opt/credseek/server/data -czf "$OUT/sqlite-data.tgz" . || true
fi

if curl -fsS "${OPENSEARCH_URL:-http://127.0.0.1:9200}" >/dev/null 2>&1; then
  curl -fsS -X PUT "${OPENSEARCH_URL}/_snapshot/credseek_fs" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"fs\",\"settings\":{\"location\":\"/usr/share/opensearch/backup\",\"compress\":true}}" || true
  curl -fsS -X PUT "${OPENSEARCH_URL}/_snapshot/credseek_fs/${STAMP}?wait_for_completion=false" || true
fi

echo "Backup written to $OUT"
