# Change: tools/list token tax ledger and pack/allow-by-need

## Why

Measured MCP `tools/list` schema cost can vary ~1700x across servers. Clients hide that context tax, so every turn dumps the full tool catalog into the model window. The gateway already fail-closes on missing credentials and per-principal allowlists; it still returns every allowlisted schema on `tools/list`. Operators need a ledger of schema cost and a way to expose only the pack a session needs.

## What Changes

- Estimate tokens (UTF-8 bytes ÷ 4 heuristic) for each listed tool schema, grouped by server and pack.
- Publish a context-tax report and HMAC ledger events; flag oversized tools and packs.
- Default `tools/list` to a **minimal pack** (catalog meta-tools + `core`) instead of the full allowlist.
- **Allow-by-need**: admit extra tools or named packs into the session, always intersected with the principal allowlist (fail-closed).
- `context.inspect` / `context.need` plus HTTP inspector paths on the existing gateway.

## Capabilities

- `mcp-gateway`: token-tax ledger, context inspector, session packs, allow-by-need (extends principal allowlists).

## Impact

- `packages/governed-mcp-gateway` behavior change: default `tools/list` is pack-scoped, not the full allowlist.
- `mode=full` remains available and is flagged when oversized.
- OpenSpec delta under this change; tests include a synthetic oversized schema fixture.
- Non-goals: live tokenizer APIs, proxying arbitrary upstream MCP servers, changing spend-plane or CFO mesh.
