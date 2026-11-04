#!/bin/sh
# Create a fresh demo repository for the agent to work on.
#   scripts/setup-demo.sh [target-dir] [extra tb init flags...]
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/threadbranch-demo}"
[ $# -gt 0 ] && shift
if [ -e "$TARGET" ]; then
  echo "$TARGET already exists; remove it or pass another path" >&2
  exit 1
fi
cp -R "$HERE/examples/demo-app" "$TARGET"
cd "$TARGET"
git init -q -b main
git add -A
git -c user.name=threadbranch -c user.email=threadbranch@localhost commit -q -m "Acme signup app"
node "$HERE/bin/tb.js" init "$@"
echo
echo "Demo repo ready: $TARGET"
echo "Use this path as the agent's working directory in the Switch template."
