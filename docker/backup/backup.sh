#!/bin/sh
# Daily pg_dump to S3-compatible storage, keeping BACKUP_KEEP_DAYS (default 14). NFR-2.
#
#   Runs once at start (so a fresh deploy has a backup), then every day at BACKUP_AT (HH:MM, Asia/Kolkata).
#   `docker compose -f docker-compose.prod.yml run --rm backup now` takes one backup and exits.
#
# Env: PGHOST PGUSER PGPASSWORD PGDATABASE · S3_ENDPOINT (empty for AWS) S3_REGION S3_ACCESS_KEY S3_SECRET_KEY
#      BACKUP_BUCKET (default: S3_BUCKET) BACKUP_PREFIX (default: backups/postgres) BACKUP_AT (default 02:30)
set -eu

: "${PGHOST:=postgres}" "${PGUSER:=lavigo}" "${PGDATABASE:=lavigo}"
: "${BACKUP_BUCKET:=${S3_BUCKET:?S3_BUCKET or BACKUP_BUCKET is required}}"
: "${BACKUP_PREFIX:=backups/postgres}" "${BACKUP_KEEP_DAYS:=14}" "${BACKUP_AT:=02:30}"
export TZ=Asia/Kolkata PGHOST PGUSER PGDATABASE
export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
export AWS_DEFAULT_REGION="${S3_REGION:-ap-south-1}"
# R2 / Spaces / MinIO need an endpoint; AWS S3 doesn't.
ENDPOINT_ARGS=""
if [ -n "${S3_ENDPOINT:-}" ]; then ENDPOINT_ARGS="--endpoint-url ${S3_ENDPOINT}"; fi

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

backup_once() {
  key="${BACKUP_PREFIX}/lavigo-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "dumping ${PGDATABASE} → s3://${BACKUP_BUCKET}/${key}"
  # --no-owner/--no-acl: restorable into a fresh database by any role.
  pg_dump --no-owner --no-acl --format=plain | gzip -9 | aws s3 cp - "s3://${BACKUP_BUCKET}/${key}" ${ENDPOINT_ARGS} --only-show-errors
  log "uploaded ${key}"
  prune
}

prune() {
  cutoff=$(date -d "@$(( $(date +%s) - BACKUP_KEEP_DAYS * 86400 ))" +%Y%m%d)
  aws s3 ls "s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/" ${ENDPOINT_ARGS} | awk '{print $4}' | while read -r name; do
    day=$(echo "$name" | sed -n 's/^lavigo-\([0-9]\{8\}\)-.*/\1/p')
    if [ -n "$day" ] && [ "$day" -lt "$cutoff" ]; then
      aws s3 rm "s3://${BACKUP_BUCKET}/${BACKUP_PREFIX}/${name}" ${ENDPOINT_ARGS} --only-show-errors && log "pruned ${name}"
    fi
  done
}

seconds_until() { # HH:MM today or tomorrow, IST
  now=$(date +%s)
  target=$(date -d "$(date +%Y-%m-%d) $1:00" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo $((target - now))
}

if [ "${1:-}" = "now" ]; then backup_once; exit 0; fi

until pg_isready -q; do log "waiting for postgres"; sleep 5; done
backup_once || log "FAILED (will retry at ${BACKUP_AT})"
while true; do
  wait_s=$(seconds_until "$BACKUP_AT")
  log "next backup in $((wait_s / 3600))h $(((wait_s % 3600) / 60))m"
  sleep "$wait_s"
  backup_once || log "FAILED (will retry tomorrow at ${BACKUP_AT})"
done
