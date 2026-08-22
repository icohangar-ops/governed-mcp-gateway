#!/usr/bin/env bash
# Publish governed-mcp-gateway to Smithery (external URL release).
#
# Docs: https://smithery.ai/docs/concepts/cli
#   smithery auth login
#   smithery mcp publish "https://host/mcp" -n org/governed-mcp-gateway
#
# Local dev without deploy — Uplink (not a registry publish):
#   npx -y @cubiczan/governed-mcp-gateway &
#   smithery mcp add http://127.0.0.1:7474/mcp/sse --id governed-gateway
#   https://smithery.ai/docs/use/uplink
set -euo pipefail

QUALIFIED_NAME="${SMITHERY_QUALIFIED_NAME:-icohangar-ops/governed-mcp-gateway}"
GATEWAY_PUBLIC_URL="${GATEWAY_PUBLIC_URL:-}"

if ! command -v smithery >/dev/null 2>&1; then
  echo "Install Smithery CLI (Node 20+): npm install -g smithery@latest"
  exit 1
fi

if [[ "${1:-}" == "--uplink-dev" ]]; then
  PORT="${PORT:-7474}"
  echo "Dev uplink (CLI must stay running). Start gateway separately:"
  echo "  npx -y @cubiczan/governed-mcp-gateway"
  echo
  exec smithery mcp add "http://127.0.0.1:${PORT}/mcp/sse" --id governed-gateway
fi

if [[ -z "${GATEWAY_PUBLIC_URL}" ]]; then
  echo "Set GATEWAY_PUBLIC_URL to a public HTTPS MCP endpoint, e.g.:"
  echo "  export GATEWAY_PUBLIC_URL=https://gateway.example.com/mcp"
  echo
  echo "Local-only (use uplink, not publish):"
  echo "  $0 --uplink-dev"
  exit 1
fi

if ! smithery auth whoami >/dev/null 2>&1; then
  echo "Authenticate first: smithery auth login"
  exit 1
fi

echo "Publishing external URL -> ${QUALIFIED_NAME}"
echo "  url: ${GATEWAY_PUBLIC_URL}"
smithery mcp publish "${GATEWAY_PUBLIC_URL}" -n "${QUALIFIED_NAME}"

echo
echo "Resume after OAuth: smithery mcp publish --resume -n ${QUALIFIED_NAME}"
