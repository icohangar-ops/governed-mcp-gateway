# Publish checklist — governed-mcp-gateway

Standalone tree: `~/Desktop/cubiczan-governed-mcp-gateway`  
Target GitHub: https://github.com/icohangar-ops/governed-mcp-gateway  
`mcpName` / `server.json`: `io.github.icohangar-ops/governed-mcp-gateway`

## 1) npm (browser OTP)

```bash
cd ~/Desktop/cubiczan-governed-mcp-gateway
npm whoami          # expect: cubiczan
npm run build && npm test
npm publish --access public
# Complete npm auth URL if prompted, then re-run if needed.
npm view @cubiczan/governed-mcp-gateway version
```

## 2) MCP Registry

```bash
mcp-publisher login github
# device flow as icohangar-ops

cd ~/Desktop/cubiczan-governed-mcp-gateway
mcp-publisher publish
# → io.github.icohangar-ops/governed-mcp-gateway@0.1.0
```

## 3) GitHub (if remote empty)

```bash
gh repo create icohangar-ops/governed-mcp-gateway --public --source=. --remote=origin --push
```

## Already done locally

- [x] Vendored shared helpers (no workspace `*` dep)
- [x] `type: module`, `bin`, `dist/` via `tsc`, `publishConfig.access: public`
- [x] `mcpName` + `server.json` (SSE transport to `:7474/mcp/sse`)
- [x] README with install, Cursor config, CHP/conductor stack diagram
