#!/usr/bin/env bash
# Deterministic upgrade: detect package manager, install all packages in one
# atomic transaction. Called by the agent during the upgrade phase.
#
# Reads:
#   PIPEKIT_PACKAGES   — newline-separated install strings (e.g. "@org/foo@1.2.3")
# Exits:
#   0   success
#   !=0 install failed (version doesn't exist, peer conflict, network, ...)
# The agent must NOT retry on failure — record a blocker and skip downstream phases.

set -eo pipefail

cd /repo

if [[ -z "${PIPEKIT_PACKAGES:-}" ]]; then
  echo "[upgrade] ERROR: PIPEKIT_PACKAGES is empty" >&2
  exit 1
fi

# Detect package manager by lockfile (pnpm > yarn > bun > npm)
if   [[ -f pnpm-lock.yaml ]];           then PM=pnpm
elif [[ -f yarn.lock ]];                then PM=yarn
elif [[ -f bun.lock || -f bun.lockb ]]; then PM=bun
else                                         PM=npm
fi

PKGS=$(echo "$PIPEKIT_PACKAGES" | tr '\n' ' ' | xargs)

echo "[upgrade] package manager: $PM"
echo "[upgrade] packages: $PKGS"

echo "[upgrade] versions before:"
for PKG in $PKGS; do
  PKG_NAME="${PKG%@*}"
  CUR=$(node -p "try { require('/repo/node_modules/${PKG_NAME}/package.json').version } catch { 'not-installed' }" 2>/dev/null || echo "not-installed")
  echo "  $PKG_NAME: $CUR"
done

# Atomic install
$PM add $PKGS

echo "[upgrade] versions after:"
for PKG in $PKGS; do
  PKG_NAME="${PKG%@*}"
  NEW=$(node -p "try { require('/repo/node_modules/${PKG_NAME}/package.json').version } catch { 'failed' }" 2>/dev/null || echo "failed")
  echo "  $PKG_NAME: $NEW"
done

echo "[upgrade] done"
