#!/usr/bin/env bash
# Remove every hook entry Oneshot added, leaving the rest of settings.json alone.
set -euo pipefail
exec "${ONESHOT_NODE:-node}" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-hooks.cjs" --uninstall
