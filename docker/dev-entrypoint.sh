#!/bin/sh
# Installs dependencies into the node_modules volume when the lockfile changed,
# then runs the given command. A lock dir prevents web and worker racing.
set -e
cd /app
STAMP=node_modules/.lockfile.sha
SUM=$(sha256sum pnpm-lock.yaml package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
  while ! mkdir node_modules/.installing 2>/dev/null; do
    echo "waiting for another container to finish pnpm install…"; sleep 3
    # A lock older than 10 minutes means the installing container died: take it over.
    find node_modules -maxdepth 1 -name .installing -mmin +10 -exec rmdir {} \; 2>/dev/null || true
    if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$SUM" ]; then break; fi
  done
  if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
    trap 'rmdir node_modules/.installing 2>/dev/null || true' EXIT
    pnpm install --frozen-lockfile
    echo "$SUM" > "$STAMP"
    rmdir node_modules/.installing 2>/dev/null || true
    trap - EXIT
  else
    rmdir node_modules/.installing 2>/dev/null || true
  fi
fi
exec "$@"
