#!/usr/bin/env bash
# scripts/install-git-hooks.sh — Permanent rollback prevention
#
# The sandbox's auto-recovery process occasionally rolls back git HEAD,
# which can drop the .git/hooks/pre-push hook (since .git/ is not tracked).
#
# This script:
# 1. Copies the tracked .githooks/pre-push into .git/hooks/
# 2. Makes it executable
# 3. Sets git config core.hooksPath to .githooks (so future auto-recoveries
#    that reset .git/hooks/ still pick up the tracked version)
#
# Run this after every git checkout/pull to ensure the hook is active.
# Idempotent — safe to run multiple times.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[install-git-hooks] Installing tracked git hooks..."

# 1. Ensure .githooks directory exists with the pre-push hook
if [ ! -f ".githooks/pre-push" ]; then
  echo "[install-git-hooks] ERROR: .githooks/pre-push not found in repo root"
  exit 1
fi

# 2. Copy the tracked hook into .git/hooks/ (in case core.hooksPath isn't supported)
mkdir -p .git/hooks
cp .githooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "[install-git-hooks] ✓ Copied .githooks/pre-push → .git/hooks/pre-push"

# 3. Set core.hooksPath to the tracked directory (survives .git/hooks resets)
git config core.hooksPath .githooks
echo "[install-git-hooks] ✓ Set core.hooksPath = .githooks"

# 4. Verify
echo "[install-git-hooks] Verification:"
echo "  core.hooksPath: $(git config core.hooksPath)"
echo "  push.default:   $(git config push.default)"
echo "  alias.pushf:     $(git config alias.pushf)"
echo "  hook executable: $([ -x .git/hooks/pre-push ] && echo 'yes' || echo 'NO')"
echo "[install-git-hooks] ✓ Done. Pre-push hook is active — destructive --force on main is blocked."
