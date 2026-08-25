#!/usr/bin/env bash
# Thin wrapper: merge the Oneshot hook block into ~/.claude/settings.json.
set -euo pipefail
exec "${ONESHOT_NODE:-node}" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-hooks.cjs" "$@"
