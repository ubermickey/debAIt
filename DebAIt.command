#!/bin/bash
# DebAIt — AI Debate Platform Launcher
cd "$(dirname "$0")"

# Kill any existing instance
lsof -ti :3456 | xargs kill 2>/dev/null

echo "Starting DebAIt server..."
node server.js &
SERVER_PID=$!

# Wait for server to be ready
for i in {1..10}; do
  if curl -s http://localhost:3456/ > /dev/null 2>&1; then
    echo "Server ready on http://localhost:3456"
    open http://localhost:3456
    break
  fi
  sleep 1
done

echo "Press Ctrl+C to stop the server."
wait $SERVER_PID
