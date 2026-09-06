# Change: Fail-closed MCP authorization + signed decision events

## Why

MCP gateways commonly fail open on missing auth, cache a Bearer/JWT on the session, and treat a tool allowlist as authorization. This gateway already maps demo Bearer keys to a Principal and filters `tools/list`, but it does not validate audience, scope, or expiry, does not bind identity plus scopes onto `_meta`, and does not emit a signed allow/deny decision. Reviewers cannot see a fail-closed deny path for a bad token.

## What Changes

- Add fail-closed Bearer authorization: missing, invalid, expired, wrong-audience, and wrong-scope tokens DENY. They never fall through to the full tool catalog.
- Re-resolve the principal from the request on every `tools/list` and `tools/call`. Do not store a JWT or Bearer on a session.
- Keep filtering `tools/list` by the intersection of policy allowlist and token scopes; enforce the same intersection again on `tools/call`.
- Bind principal id, allowed tools, and scopes onto `params._meta.cubiczan` for downstream tools.
- Append a signed `authz.decision` event (canonical JSON + HMAC, existing `AuditLedger` / `prevSig` chain) for allow and deny.
- Bind CHP human locks to a tool + argument hash so changed arguments after approval and replay of a consumed lock are denied.
- Document the threat model: allowlist ≠ authorization; ThreadLocal principal is unsafe; session reuse across users is unsafe.

## Capabilities

- `mcp-gateway`: fail-closed Bearer auth, per-call principal re-resolution, allowlist ∩ scope enforcement, signed authorization decisions, CHP lock argument binding.

## Impact

- `packages/governed-mcp-gateway` (auth helper, gateway dispatch, tests, README).
- OpenSpec delta under this change. Shared CHP/ledger primitives are reused, not replaced.
- Demo opaque Bearer keys remain the default path; signed claim tokens are an adapter behind the same `Principal` type.
- Non-goals: OAuth/OIDC provider, a new package name, live network token introspection.
