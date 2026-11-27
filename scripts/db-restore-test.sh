#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL to an isolated restore-test database}"
: "${BACKUP_FILE:?Set BACKUP_FILE to a verified .dump file}"
if [[ "$RESTORE_DATABASE_URL" == "${DATABASE_URL:-}" ]]; then
  echo "Refusing to restore into DATABASE_URL; use a dedicated isolated RESTORE_DATABASE_URL." >&2
  exit 2
fi
sha256sum --check "$BACKUP_FILE.sha256"
pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-acl --exit-on-error "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) AS restored_tables FROM information_schema.tables WHERE table_schema='public';"
echo "Restore completed. Run application smoke tests against this isolated database."
