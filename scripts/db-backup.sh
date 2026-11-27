#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the source PostgreSQL database}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/barberpro-$stamp.dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$file"
sha256sum "$file" > "$file.sha256"
echo "Backup created: $file"
