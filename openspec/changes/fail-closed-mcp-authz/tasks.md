# Tasks

## 1. Authorization helper

- [x] 1.1 Fail-closed Bearer authorize (missing, invalid, expired, wrong-audience, wrong-scope)
- [x] 1.2 Opaque demo keys synthesize audience + `mcp.invoke` (no session store)
- [x] 1.3 HMAC `czb1` claim tokens for tests (canonical JSON + existing `hmacHex`)

## 2. Gateway enforcement

- [x] 2.1 Re-resolve principal on every `tools/list` and `tools/call`
- [x] 2.2 Filter `tools/list` by allowlist ∩ scopes; enforce again on `tools/call`
- [x] 2.3 Bind principal, allowed tools, scopes onto `params._meta.cubiczan`
- [x] 2.4 Signed `authz.decision` ledger events (allow/deny, tool, arg hash, principal, policy version, prevSig)
- [x] 2.5 CHP lock binds tool + arg hash; deny changed arguments and replay

## 3. Tests and docs

- [x] 3.1 Negative tests for token defects, allowlist, scope, list filter, session isolation
- [x] 3.2 CHP changed-arguments + replay tests
- [x] 3.3 README threat-model section
