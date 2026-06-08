#!/usr/bin/env sh
set -e

if command -v npm >/dev/null 2>&1; then
  exec npm run dev
fi

if [ -x "/opt/homebrew/bin/npm" ]; then
  exec /opt/homebrew/bin/npm run dev
fi

if command -v node >/dev/null 2>&1; then
  echo "npm was not found, so the Next.js app cannot start."
  echo "Try: /opt/homebrew/bin/npm run dev"
  exit 1
fi

CODEX_NODE="/Users/adam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [ -x "$CODEX_NODE" ]; then
  echo "npm was not found, so the Next.js app cannot start."
  echo "Try: /opt/homebrew/bin/npm run dev"
  exit 1
fi

echo "Node.js was not found."
echo "Install it from https://nodejs.org or with Homebrew: brew install node"
exit 1
