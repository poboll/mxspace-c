#!/usr/bin/env bash
# Compatibility entrypoint: never use the old binary-only rollback path again.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/caiths-controlled-deploy.sh" "$@"
