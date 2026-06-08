#!/usr/bin/env sh
set -e

PORT="${1:-3000}"

PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"

if [ -z "$PIDS" ]; then
  echo "No server is running on port $PORT."
  exit 0
fi

echo "Stopping process(es) on port $PORT: $PIDS"
kill $PIDS
echo "Stopped."
