#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

# Deployment-specific settings live here, outside version control:
#   LEARN_MCP_OAUTH_PASSWORD    the only credential guarding this server
#   LEARN_MCP_PUBLIC_BASE_URL   e.g. https://mcp.example.com
#   LEARN_MCP_RESOURCE_URL      e.g. https://mcp.example.com/mcp
#   LEARN_MCP_ALLOWED_HOSTS     hostnames the reverse proxy forwards, comma separated
if [ -f ".local/server.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ".local/server.env"
  set +a
fi

# Public identity has no default on purpose. Baking a hostname in would make a
# misconfigured deploy publish OAuth metadata pointing at someone else's domain,
# and clients would send their tokens there.
for required in LEARN_MCP_PUBLIC_BASE_URL LEARN_MCP_RESOURCE_URL LEARN_MCP_ALLOWED_HOSTS LEARN_MCP_OAUTH_PASSWORD; do
  if [ -z "${!required:-}" ]; then
    echo "start-http.sh: $required is not set. Define it in .local/server.env." >&2
    exit 1
  fi
done

STATE_HOME="${LEARN_STATE_HOME:-$HOME/.uwlearn-mcp}"

export LEARN_MCP_HOST="${LEARN_MCP_HOST:-127.0.0.1}"
export LEARN_MCP_PORT="${LEARN_MCP_PORT:-8787}"
export LEARN_AUTH_URL="${LEARN_AUTH_URL:-http://127.0.0.1:${LEARN_MCP_PORT:-8787}/auth}"
export LEARN_HEADLESS="${LEARN_HEADLESS:-true}"
export LEARN_BASE_URL="${LEARN_BASE_URL:-https://learn.uwaterloo.ca}"
export LEARN_PROFILE_DIR="${LEARN_PROFILE_DIR:-$STATE_HOME/playwright-profile}"
export LEARN_STORAGE_STATE_PATH="${LEARN_STORAGE_STATE_PATH:-$STATE_HOME/storage-state.json}"
export LEARN_OAUTH_TOKEN_STORE_PATH="${LEARN_OAUTH_TOKEN_STORE_PATH:-$STATE_HOME/oauth-tokens.json}"
export LEARN_DOWNLOAD_DIR="${LEARN_DOWNLOAD_DIR:-$STATE_HOME/downloads}"

exec node dist/httpServer.js
