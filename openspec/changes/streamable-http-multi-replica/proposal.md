# Change: Streamable HTTP multi-replica session runbook

## Why

Stack Overflow [79962720](https://stackoverflow.com/questions/79962720) (Spring AI MCP MVC Streamable HTTP on Kubernetes) is the production failure this gateway must not repeat: `initialize` mints `Mcp-Session-Id` on replica A, the Service/Ingress load-balances `tools/list` or `tools/call` to replica B, and B does not have the in-process session. Today Cubiczan pack state lives in a process-local `Map`. Operators must not discover that as accidental session affinity.

## What Changes

- Document three deployment options: **sticky ingress**, **externalized session store**, **fail-closed STATELESS**.
- Mint and honor `Mcp-Session-Id` only in `sticky` / `shared` modes; default **STATELESS** so `tools/list` and `tools/call` need only Bearer + host-injected principal.
- Fail closed on missing / stale / unknown transport sessions with actionable reason codes (`MISSING_SESSION`, `SESSION_STICKY_MISMATCH`, `UNKNOWN_SESSION`) — never a silent empty HTTP 200.
- Pluggable `SessionStore` + in-memory / Redis-like implementations for tests (no live Redis in CI).
- Cookbook under `docs/streamable-http-multi-replica.md` with Kubernetes/ingress notes and curl proofs.

## Capabilities

- `mcp-gateway`: Streamable HTTP session modes, fail-closed session errors, shared session store (extends principal-on-RPC and pack-by-need).

## Impact

- `packages/governed-mcp-gateway` gains explicit session modes; default remains usable without `Mcp-Session-Id` (STATELESS).
- Existing Bearer fail-closed, claim→allowlist, pack-by-need, and `_meta.cubiczan.principal` stay intact.
- Non-goals: posting to Stack Overflow, live Redis in CI, changing spend-plane or CFO mesh.
