# Change: host-injected `_meta` params + token-tax polish

## Why

Clients want a subset of tools without forking servers (session pack / allow-by-need — already shipped). Hosts also need to inject tenant, index, and vaulted keys **without the LLM choosing them**. MCP `_meta` is the out-of-band channel; tool `arguments` are the model's. If the model invents host-only identifiers, the gateway must strip or deny them. Schema token tax should attribute description vs inputSchema so operators can see what bloats `tools/list`.

## What Changes

- Bind host-only params (`tenant`, `index`, vaulted input names) at the gateway from the authenticated principal, HTTP headers/query, and `params._meta.cubiczan.host`.
- Overwrite `_meta.cubiczan.principal` from the Bearer principal. Deny impersonation and tenant/org mismatches.
- Strip host-only keys from listed `inputSchema`. Deny `tools/call` when `arguments` contain host-only identifiers (including vaulted names such as `github_token`).
- Token-tax ledger records description vs schema bytes/tokens and oversized flags; GET `/v1/context/tax` estate report stays authenticated.
- Harden negative tests and a README cookbook. Fail-closed auth is unchanged.

## Capabilities

- `mcp-gateway`: host-injected `_meta`, vaulted-input binding, description/schema tax split (extends pack / allow-by-need).

## Impact

- `packages/governed-mcp-gateway`: `host-meta.ts`, catalog `index.query`, `tools/call` bind/deny, tax breakdown.
- OpenSpec delta under this change. No spend-plane or CFO mesh behavior change.
- Non-goals: live tokenizer APIs, proxying arbitrary upstream MCP servers, putting secrets in `_meta`.
