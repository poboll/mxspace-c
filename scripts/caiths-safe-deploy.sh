#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${MX_SPACE_INSTALL_DIR:-/root/mx-space}"
APP_DIR="${MX_SPACE_APP_DIR:-$INSTALL_DIR/core-v10}"
APP_NAME="${MX_SPACE_PM2_APP_NAME:-mx-server}"
HEALTH_URL="${MX_SPACE_HEALTH_URL:-http://127.0.0.1:2333/api/v3/health}"
ROLLBACK_KEEP="${MX_SPACE_ROLLBACK_KEEP:-3}"
ZIP_PATH="${1:-}"

if [[ -z "$ZIP_PATH" || ! -f "$ZIP_PATH" ]]; then
  echo "usage: $0 /path/to/release-linux.zip" >&2
  exit 64
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${APP_DIR}.backup-${timestamp}"
staging_dir="${APP_DIR}.staging-${timestamp}"
deploy_log="${INSTALL_DIR}/deploy-${timestamp}.log"

mkdir -p "$INSTALL_DIR"
exec > >(tee "$deploy_log") 2>&1

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

on_error() {
  local status=$?
  trap - ERR
  rollback || true
  exit "$status"
}
trap on_error ERR

health_check() {
  local attempts="${1:-12}"
  local delay="${2:-5}"

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS -m 10 "$HEALTH_URL" \
      -H 'user-agent: Mozilla/5.0 (MX Space deploy healthcheck)' >/dev/null; then
      return 0
    fi
    log "health check failed (${i}/${attempts}); retrying in ${delay}s"
    sleep "$delay"
  done

  return 1
}

rollback() {
  log "deployment failed; rolling back"
  if [[ ! -d "$backup_dir" ]]; then
    log "no backup directory was created; current app directory was not switched"
    return
  fi

  pm2 stop "$APP_NAME" || true
  rm -rf "$APP_DIR"
  mv "$backup_dir" "$APP_DIR"
  if [[ -f "$APP_DIR/ecosystem.config.cjs" ]]; then
    (cd "$APP_DIR" && pm2 delete "$APP_NAME" || true)
    (cd "$APP_DIR" && pm2 start ecosystem.config.cjs --only "$APP_NAME")
  else
    (cd "$APP_DIR" && pm2 start main.mjs --name "$APP_NAME")
  fi
  health_check 12 5 || true
  pm2 save || true
}

log "deploying $ZIP_PATH to $APP_DIR"
rm -rf "$staging_dir"
mkdir -p "$staging_dir"
unzip -q "$ZIP_PATH" -d "$staging_dir"

for file in ecosystem.config.cjs .env; do
  if [[ -f "$APP_DIR/$file" && ! -f "$staging_dir/$file" ]]; then
    cp "$APP_DIR/$file" "$staging_dir/$file"
  elif [[ "$file" == "ecosystem.config.cjs" && -f "$APP_DIR/$file" ]]; then
    cp "$APP_DIR/$file" "$staging_dir/$file"
  fi
done

if [[ -L "$APP_DIR/node_modules" && ! -e "$staging_dir/node_modules" ]]; then
  cp -P "$APP_DIR/node_modules" "$staging_dir/node_modules"
fi

if [[ -f "$staging_dir/migrate.mjs" ]]; then
  log "running database migrations from staging"
  (
    cd "$staging_dir"
    eval "$(
      APP_NAME="$APP_NAME" node -e "const path=require('node:path'); const cfg=require(path.resolve('ecosystem.config.cjs')); const env=(cfg.apps||[]).find((app)=>app.name===process.env.APP_NAME)?.env || {}; for (const [key,value] of Object.entries(env)) console.log('export '+key+'='+JSON.stringify(String(value)))"
    )"
    if [[ -d "$staging_dir/src/database/migrations" ]]; then
      export MIGRATIONS_DIR="$staging_dir/src/database/migrations"
    fi
    node migrate.mjs
  )
fi

if [[ -d "$APP_DIR" ]]; then
  rm -rf "$backup_dir"
  mv "$APP_DIR" "$backup_dir"
fi
mv "$staging_dir" "$APP_DIR"

log "reloading pm2 app $APP_NAME"
if [[ -f "$APP_DIR/ecosystem.config.cjs" ]]; then
  (cd "$APP_DIR" && pm2 reload ecosystem.config.cjs --only "$APP_NAME")
else
  pm2 reload "$APP_NAME"
fi

log "waiting for health check"
health_check 18 5

pm2 save
rm -f "$ZIP_PATH"
rm -rf "$backup_dir"
find "$INSTALL_DIR" -maxdepth 1 -type d -name 'core-v10.backup-*' \
  -printf '%T@ %p\n' | sort -rn | awk -v keep="$ROLLBACK_KEEP" 'NR > keep { print $2 }' | xargs -r rm -rf
find "$INSTALL_DIR" -maxdepth 1 -type f -name 'deploy-*.log' -mtime +14 -delete
trap - ERR
log "deployment completed"
