# Design: Fail-closed MCP authorization

## Current path (verified)

Demo Bearer API keys are the only auth path. `resolvePrincipal` hashes the Bearer and looks up an agent. Missing or unknown keys return `undefined` and HTTP 401. There is no session JWT store. `tools/list` already uses the principal allowlist; `tools/call` checks it again. The HMAC `AuditLedger` already chains `prevSig` + `sig`. CHP `/v1/locks` exists but is not bound to a tool call or argument hash.

## Decisions

1. **Harden the existing Bearer path; do not add a parallel auth stack.** Opaque demo keys keep working. They synthesize claims (`aud`, `scope: ["mcp.invoke"]`) after lookup. Structured tokens use the existing HMAC + canonical JSON helpers (`czb1.<payload>.<sig>`) so tests can exercise expiry, audience, and scope without a JWT library or runtime dependency.

2. **Fail closed in one `authorize()` helper.** Any of missing / invalid / expired / wrong-audience / wrong-scope returns a deny reason. The HTTP handler maps those to 401 and never lists or dispatches tools. An empty allowlist is an empty catalog, not "all tools".

3. **Re-resolve on every `tools/list` and `tools/call`.** `authenticate(req)` reads the current `Authorization` header. The gateway does not keep a session map of tokens or principals. SSE resolves the principal on the request that opened the stream and repeats it on the frame; it does not stash the raw Bearer.

4. **Allowlist ∩ token scope.** Allowlist is catalog policy. Token `scope` is the authorization grant. A PayOps key scoped only to `echo.ping` cannot call `stripe.charge` even though the allowlist includes it. `mcp.invoke` means "any allowlisted tool" and is what demo keys receive.

5. **Identity on `_meta`, not ThreadLocal.** `params._meta.cubiczan` carries `principal`, `allowedTools`, `scopes`, and `policyVersion`. Tools read metadata. No JWT is copied onto the session or into `_meta`.

6. **Signed decisions reuse `AuditLedger`.** Event `authz.decision` records `decision`, `tool`, `argHash`, `principalId`, `policyVersion`, `reason`. The ledger supplies `ts`, `prevSig`, and HMAC `sig`.

7. **CHP locks bind to `argHash`.** When `stripe.charge` is not auto-LOCKED, the gateway stores a single-use pending lock `{ principalId, tool, argHash }`. Approval of that lock does not authorize different arguments. A consumed lock cannot be replayed.

## Threat model (summary)

| Failure | Why it is unsafe | This design |
|---|---|---|
| Fail open on bad auth | Missing token becomes anonymous all-tools | Deny, empty catalog |
| Allowlist as authz | Catalog membership ≠ grant | Scope check is separate |
| ThreadLocal principal | SSE/tool worker drops identity | `_meta` on every call/frame |
| Session-cached JWT | Next user on the socket inherits the grant | Re-resolve per `tools/list` / `tools/call` |
| Unbound human lock | Approved $50, replay $5,000 | `argHash` + consume-once |

## Trade-offs

- Custom `czb1` tokens instead of JOSE: matches "zero runtime deps" and the existing HMAC ledger. An OAuth introspector can later mint the same `Principal` + claims.
- 401 for token defects vs JSON-RPC `-32001` for allowlist misses: keeps "not authenticated / not granted" distinct from "authenticated but not in catalog".
