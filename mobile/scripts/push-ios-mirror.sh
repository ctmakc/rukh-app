#!/usr/bin/env bash
# Push the iOS build inputs to the public build mirror ctmakc/rukh-app (branch main).
# Why a mirror: GitHub does not start macOS jobs in the private repo (Actions billing), public repos build free.
# The mirror holds only mobile/ (without store/ tools, screenshots, keys) + public/ (the same files rukh.mmix.biz
# serves) + .github/. Secrets (signing, ASC key) live in the mirror's GitHub secrets, never in files.
set -euo pipefail
cd "$(dirname "$0")/../.."
MIRROR=${MIRROR:-ctmakc/rukh-app}
SRC_REV=$(git rev-parse --short HEAD)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
git clone -q --depth 1 "https://github.com/$MIRROR.git" "$W/m"
find "$W/m" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD mobile public .github | tar -x -C "$W/m"
rm -rf "$W/m/mobile/store" "$W/m/public/demo"
printf '# RUKH app — iOS build inputs\n\nBuild-only mirror of the RUKH native shell (Capacitor) and the web app it bundles\n(the same code served at https://rukh.mmix.biz). Source revision: %s.\n' "$SRC_REV" > "$W/m/README.md"
printf 'node_modules/\n' > "$W/m/.gitignore"
cd "$W/m"; git add -A
if git diff --cached --quiet; then echo "mirror already at $SRC_REV"; exit 0; fi
git -c user.name=ctmakc -c user.email=ctmakc@users.noreply.github.com commit -q -m "mirror $SRC_REV"
git push -q origin HEAD:main
echo "mirror pushed: $SRC_REV"
