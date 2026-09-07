# Tasks

## 1. Spec and store

- [x] 1.1 OpenSpec proposal, design, and mcp-gateway spec deltas
- [x] 1.2 `SessionStore` interface + in-memory and Redis-like implementations
- [x] 1.3 Reason codes: `MISSING_SESSION`, `SESSION_STICKY_MISMATCH`, `UNKNOWN_SESSION`

## 2. Gateway

- [x] 2.1 Session modes `stateless` | `sticky` | `shared` (env `MCP_SESSION_MODE`)
- [x] 2.2 `initialize` mints `Mcp-Session-Id` only in sticky/shared
- [x] 2.3 Fail-closed JSON-RPC + HTTP error (never empty 200)
- [x] 2.4 Context pack store backed by the same `SessionStore` when injected
- [x] 2.5 Keep Bearer, allowlist, pack-by-need, and `_meta.cubiczan.principal`

## 3. Proof and cookbook

- [x] 3.1 Tests: missing/stale session fails closed with a reason
- [x] 3.2 Tests: two instances — sticky mismatch vs shared-store success
- [x] 3.3 Cookbook `docs/streamable-http-multi-replica.md` + README links
