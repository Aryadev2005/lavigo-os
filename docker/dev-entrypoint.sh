#!/bin/sh
# Installs dependencies into the node_modules volume when the lockfile changed,
# then runs the given command. A lock dir prevents web and worker racing.
#
# The lock dir holds `owner` (the installing container's hostname = its short ID, which the
# compose network resolves while that container exists). A waiting container takes the lock over
# when it is stale: older than 10 minutes, or its owner container is gone, or the owner is this
# same container (a previous start that died mid-install).
set -e
cd /app
STAMP=node_modules/.lockfile.sha
LOCK=node_modules/.installing
SUM=$(sha256sum pnpm-lock.yaml package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
ME=$(hostname)

fresh() { [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$SUM" ]; }

lock_is_stale() {
  [ -d "$LOCK" ] || return 1
  # Older than 10 minutes.
  [ -n "$(find node_modules -maxdepth 1 -name .installing -mmin +10 2>/dev/null)" ] && return 0
  owner=$(cat "$LOCK/owner" 2>/dev/null || true)
  if [ -z "$owner" ]; then
    # mkdir and the owner write aren't atomic: give a fresh lock a minute before judging it.
    [ -n "$(find node_modules -maxdepth 1 -name .installing -mmin +1 2>/dev/null)" ] && return 0
    return 1
  fi
  [ "$owner" = "$ME" ] && return 0
  getent hosts "$owner" >/dev/null 2>&1 || return 0
  return 1
}

if ! fresh; then
  waited=0
  announced=0
  mine=0
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      mine=1
      echo "$ME" > "$LOCK/owner"
      break
    fi
    if fresh; then break; fi
    if lock_is_stale; then
      echo "pnpm install lock is stale (owner: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)); retrying the install"
      rm -rf "$LOCK"
      continue
    fi
    if [ "$announced" -eq 0 ]; then
      echo "waiting for pnpm install…"
      announced=1
    elif [ $((waited % 15)) -eq 0 ]; then
      echo "still waiting for pnpm install… ${waited}s"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$mine" -eq 1 ]; then
    trap 'rm -rf "$LOCK"' EXIT
    fresh || pnpm install --frozen-lockfile
    echo "$SUM" > "$STAMP"
    rm -rf "$LOCK"
    trap - EXIT
  fi
fi
exec "$@"
