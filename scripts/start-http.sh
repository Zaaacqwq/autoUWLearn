#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

if [ -f ".local/server.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ".local/server.env"
  set +a
fi

export LEARN_MCP_HOST="${LEARN_MCP_HOST:-127.0.0.1}"
export LEARN_MCP_PORT="${LEARN_MCP_PORT:-8787}"
export LEARN_MCP_ALLOWED_HOSTS="${LEARN_MCP_ALLOWED_HOSTS:-mcp.example.com,mcp.example.com:443,127.0.0.1,localhost}"
export LEARN_MCP_PUBLIC_BASE_URL="${LEARN_MCP_PUBLIC_BASE_URL:-https://mcp.example.com}"
export LEARN_MCP_RESOURCE_URL="${LEARN_MCP_RESOURCE_URL:-https://mcp.example.com/mcp}"
export LEARN_AUTH_URL="${LEARN_AUTH_URL:-http://127.0.0.1:8787/auth}"
export LEARN_HEADLESS="${LEARN_HEADLESS:-true}"
export LEARN_BASE_URL="${LEARN_BASE_URL:-https://learn.uwaterloo.ca}"
export LEARN_PROFILE_DIR="${LEARN_PROFILE_DIR:-/Users/user/.uwlearn-mcp/playwright-profile}"
export LEARN_STORAGE_STATE_PATH="${LEARN_STORAGE_STATE_PATH:-/Users/user/.uwlearn-mcp/storage-state.json}"
export LEARN_OAUTH_TOKEN_STORE_PATH="${LEARN_OAUTH_TOKEN_STORE_PATH:-/Users/user/.uwlearn-mcp/oauth-tokens.json}"
export LEARN_DOWNLOAD_DIR="${LEARN_DOWNLOAD_DIR:-/Users/user/.uwlearn-mcp/downloads}"

exec /opt/homebrew/bin/node dist/httpServer.js
