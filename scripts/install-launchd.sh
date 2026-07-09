#!/usr/bin/env bash
#
# Renders the launchd templates for this machine and loads them.
#
#   scripts/install-launchd.sh                    # MCP server only
#   scripts/install-launchd.sh --tunnel NAME      # also run a cloudflared tunnel
#
# The templates carry no absolute paths so that the repository does not record
# one machine's home directory.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
TUNNEL_NAME=""
CLOUDFLARED_CONFIG="$HOME/.cloudflared/config.yml"

while [ $# -gt 0 ]; do
  case "$1" in
    --tunnel) TUNNEL_NAME="${2:?--tunnel needs a tunnel name}"; shift 2 ;;
    --cloudflared-config) CLOUDFLARED_CONFIG="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$REPO_DIR/.local/server.env" ]; then
  echo "Missing $REPO_DIR/.local/server.env. See readme.md for the required variables." >&2
  exit 1
fi

mkdir -p "$AGENTS"

render() {
  sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
      -e "s|__CLOUDFLARED_CONFIG__|$CLOUDFLARED_CONFIG|g" \
      -e "s|__TUNNEL_NAME__|$TUNNEL_NAME|g" "$1" > "$2"
}

reload() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "loaded $label"
}

render "$REPO_DIR/launchd/com.autouwlearn.mcp.plist.template" "$AGENTS/com.autouwlearn.mcp.plist"
reload "com.autouwlearn.mcp" "$AGENTS/com.autouwlearn.mcp.plist"

if [ -n "$TUNNEL_NAME" ]; then
  render "$REPO_DIR/launchd/com.cloudflared.tunnel.plist.template" "$AGENTS/com.cloudflared.tunnel.plist"
  reload "com.cloudflared.tunnel" "$AGENTS/com.cloudflared.tunnel.plist"
fi
