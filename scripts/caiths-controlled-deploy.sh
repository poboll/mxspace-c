#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/node26/bin:$PATH
INSTALL_DIR="${MX_SPACE_INSTALL_DIR:-/root/mx-space}"
APP_DIR="${MX_SPACE_APP_DIR:-$INSTALL_DIR/core-v15}"
APP_NAME="${MX_SPACE_PM2_APP_NAME:-mx-server}"
HEALTH_URL="${MX_SPACE_HEALTH_URL:-http://127.0.0.1:2333/api/v3/health}"
ZIP_PATH="${1:-}"
HELPER="$(cd "$(dirname "$0")" && pwd)/caiths-db-snapshot.mjs"
[[ "$APP_DIR" == "$INSTALL_DIR/"* && "$APP_DIR" != "$INSTALL_DIR/" && -d "$APP_DIR" && -f "$ZIP_PATH" && -f "$HELPER" ]] || exit 64
[[ -f "$APP_DIR/ecosystem.config.cjs" ]] || exit 65
exec 9>"$INSTALL_DIR/.deploy.lock"
flock -n 9 || { echo 'another deployment owns lock'; exit 75; }
stamp="$(date +%Y%m%d-%H%M%S)-$$"
backup_dir="${APP_DIR}.backup-${stamp}"
staging_dir="${APP_DIR}.staging-${stamp}"
recovery_dir="$INSTALL_DIR/recovery-${stamp}"
mkdir -m 700 "$recovery_dir" "$staging_dir"
exec > >(tee "$recovery_dir/deploy.log") 2>&1
stopped=0
migration_started=0
switched=0
committed=0
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
health_check() {
  local attempt
  for ((attempt=0; attempt<18; attempt++)); do
    if curl -fsS -m 10 "$HEALTH_URL" -H 'user-agent: MX-Space-deploy-healthcheck' >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}
start_app() {
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  (cd "$APP_DIR" && pm2 start ecosystem.config.cjs --only "$APP_NAME" >/dev/null)
}
finish() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 && committed == 0 && stopped == 1 )); then
    log 'deployment failed; restoring database and program before reopening'
    pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
    if (( migration_started )); then
      if ! node "$HELPER" rollback "$recovery_dir" "$recovery_dir"; then
        log 'CRITICAL: database recovery failed; app left STOPPED; manual recovery required'
        exit 71
      fi
    fi
    if [[ -d "$backup_dir" ]]; then
      if [[ -d "$APP_DIR" ]]; then
        mv "$APP_DIR" "${APP_DIR}.failed-${stamp}" || exit 72
      fi
      mv "$backup_dir" "$APP_DIR" || exit 72
    fi
    if start_app && health_check; then
      pm2 save >/dev/null
      log 'old database/program restored and healthy'
    else
      pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
      log 'CRITICAL: old app unhealthy; app left STOPPED'
      exit 73
    fi
  fi
  # Retain backups, failed/staging artifacts and private diagnostics; no automatic deletion.
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
log 'extracting candidate before maintenance window'
unzip -q "$ZIP_PATH" -d "$staging_dir"
for required in main.mjs migrate.mjs src/database/migrations/meta/_journal.json node_modules/ws/package.json node_modules/sharp/package.json node_modules/loro-crdt/package.json; do
  [[ -f "$staging_dir/$required" ]] || { log "missing release file: $required"; exit 65; }
done
cp "$APP_DIR/ecosystem.config.cjs" "$staging_dir/ecosystem.config.cjs"
[[ ! -f "$APP_DIR/.env" ]] || cp "$APP_DIR/.env" "$staging_dir/.env"
cp "$APP_DIR/ecosystem.config.cjs" "$recovery_dir/ecosystem.config.cjs"
log 'stopping writer for final snapshot and verified shadow restore'
stopped=1
pm2 stop "$APP_NAME" >/dev/null
node "$HELPER" prepare "$APP_DIR" "$recovery_dir"
migration_started=1
node "$HELPER" migrate "$staging_dir" "$recovery_dir"
mv "$APP_DIR" "$backup_dir"
mv "$staging_dir" "$APP_DIR"
switched=1
start_app
health_check || { log 'new app health check failed'; exit 70; }
pm2 save >/dev/null
committed=1
log "deployment healthy; program and verified database recovery retained in $recovery_dir"
