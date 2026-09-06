# mcp-gateway Specification

## ADDED Requirements

### Requirement: Bearer authorization is fail-closed
The gateway SHALL deny a request when the Bearer token is missing, invalid, expired, issued for the wrong audience, or lacks the required scope. A deny SHALL NOT expose or dispatch the full tool catalog.

#### Scenario: Missing credential is rejected
- GIVEN a request with no Authorization header
- WHEN the client sends `tools/call`
- THEN the gateway returns HTTP 401
- AND no tool runs

#### Scenario: Invalid credential is rejected
- GIVEN a request with a Bearer token that is not a registered key and not a valid signed claim token
- WHEN the client sends `tools/list` or `tools/call`
- THEN the gateway returns HTTP 401
- AND `tools/list` is not the full catalog

#### Scenario: Expired token is rejected
- GIVEN a signed claim token whose `exp` is in the past
- WHEN the client sends `tools/call`
- THEN the gateway returns HTTP 401 with reason `expired`
- AND no tool runs

#### Scenario: Wrong-audience token is rejected
- GIVEN a signed claim token whose `aud` is not the gateway audience
- WHEN the client sends `tools/call`
- THEN the gateway returns HTTP 401 with reason `wrong_audience`
- AND no tool runs

#### Scenario: Wrong-scope token is rejected
- GIVEN a valid token for a principal whose allowlist includes `stripe.charge`
- AND the token scope does not include `stripe.charge` or `mcp.invoke`
- WHEN the client sends `tools/call` for `stripe.charge`
- THEN the gateway returns HTTP 401 with reason `wrong_scope`
- AND no tool runs

### Requirement: Principal is re-resolved on every tools/list and tools/call
The gateway SHALL resolve the Bearer credential to a Principal on every `tools/list` and `tools/call`. The gateway SHALL NOT store a JWT or Bearer token on a session object and reuse it for a later method.

#### Scenario: Sequential calls with different credentials do not inherit identity
- GIVEN two valid Bearer credentials for different principals
- WHEN `tools/call` is sent with the first credential and then `tools/call` is sent with the second on the same server
- THEN each result `_meta` carries that request's principal
- AND the second call does not retain the first principal

### Requirement: Tool visibility is allowlist intersected with token scope
The gateway SHALL list only tools that appear on the principal's allowlist AND are permitted by the token scope. The gateway SHALL enforce the same intersection on `tools/call`. An empty allowlist SHALL list no tools.

#### Scenario: tools/list hides tools outside the allowlist
- GIVEN principal `agt_research` allowlisted for `echo.ping` and `search.web`
- WHEN it calls `tools/list`
- THEN the result does not include `stripe.charge`

#### Scenario: Disallowed tool does not run
- GIVEN principal `agt_research` allowlisted for `search.web` only
- WHEN it calls `stripe.charge`
- THEN the gateway returns a JSON-RPC error
- AND no spend-plane request is made

### Requirement: Identity and grants are bound onto params._meta
On every `tools/call`, the gateway SHALL inject `params._meta.cubiczan` with the principal, the allowed tools for this request, and the token scopes before the tool runs. The gateway SHALL NOT place the raw Bearer or JWT onto `_meta`.

#### Scenario: Authenticated tool call carries principal and grants
- GIVEN a valid Bearer API key mapped to principal `agt_payops`
- WHEN the client sends `tools/call` for an allowed tool
- THEN the dispatched call includes `_meta.cubiczan.principal.id = agt_payops`
- AND `_meta.cubiczan.allowedTools` is the allowlist ∩ scope intersection
- AND `_meta.cubiczan.scopes` is present
- AND the tool result includes the same principal

### Requirement: Authorization decisions are signed onto the ledger
The gateway SHALL append an `authz.decision` record to the HMAC audit ledger for every allow and deny that reaches tool authorization. The record SHALL include decision, tool name, argument hash, principal id, policy version, timestamp, `prevSig`, and `sig`.

#### Scenario: Deny is signed
- GIVEN an authenticated principal that is not allowlisted for `stripe.charge`
- WHEN it calls `stripe.charge`
- THEN the ledger contains an `authz.decision` event with `decision = deny`
- AND `ledger.verify()` succeeds

#### Scenario: Allow is signed
- GIVEN an authenticated principal calling an allowed in-policy tool
- WHEN the tool runs
- THEN the ledger contains an `authz.decision` event with `decision = allow`
- AND the record chains to the previous signature

### Requirement: Human lock is bound to tool arguments
When CHP requires a human lock, the gateway SHALL bind the pending lock to the principal, tool name, and canonical argument hash. A later `tools/call` with different arguments SHALL be denied. A consumed lock SHALL NOT authorize a replay.

#### Scenario: Changed arguments after approval are denied
- GIVEN a `stripe.charge` call that required a human lock
- AND a human approved that pending lock
- WHEN the agent retries `tools/call` with a different `amountCents`
- THEN the gateway returns a JSON-RPC error for changed arguments
- AND the charge does not run

#### Scenario: Replay of a consumed lock is denied
- GIVEN a human-approved lock that already authorized one matching `tools/call`
- WHEN the agent sends the same `tools/call` again
- THEN the gateway denies the replay
- AND the charge does not run a second time
