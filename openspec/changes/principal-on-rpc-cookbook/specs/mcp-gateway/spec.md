# mcp-gateway Specification

## ADDED Requirements

### Requirement: Principal and scopes travel on the RPC message
The gateway SHALL resolve a Bearer credential at the HTTP boundary and SHALL stamp the Principal and its scopes onto the JSON-RPC params `_meta` before any tool runs. Tool dispatch SHALL read identity from `_meta`, not from ThreadLocal, request locals, or language contextvars.

#### Scenario: Authenticated tool call stamps principal and scopes
- GIVEN a valid HS256 Bearer JWT for principal `agt_payops` with scope `tools:echo`
- WHEN the client sends `tools/call` for `echo.ping`
- THEN `params._meta.principal.id` and `_meta.cubiczan.principal.id` equal `agt_payops`
- AND `_meta.scopes` includes `tools:echo`

#### Scenario: SSE frame repeats principal
- GIVEN an authenticated SSE session
- WHEN the gateway emits a notification
- THEN the event JSON includes `_meta.principal` (or `_meta.cubiczan.principal`) for that caller

### Requirement: Bearer claim failures are fail-closed
The gateway SHALL reject a request with HTTP 401 and SHALL NOT run a tool when the Bearer token is missing, invalid, expired, or presented for the wrong audience.

#### Scenario: Missing Bearer
- GIVEN a request with no Authorization header
- WHEN the client sends `tools/call`
- THEN the gateway returns HTTP 401

#### Scenario: Invalid Bearer
- GIVEN a token that is not a registered API key and is not a valid HS256 JWT
- WHEN the client sends `tools/list`
- THEN the gateway returns HTTP 401

#### Scenario: Expired Bearer
- GIVEN an otherwise well-formed JWT whose `exp` is in the past
- WHEN the client sends `tools/list`
- THEN the gateway returns HTTP 401

#### Scenario: Wrong audience
- GIVEN a well-formed JWT whose `aud` is not the gateway audience
- WHEN the client sends `tools/list`
- THEN the gateway returns HTTP 401

### Requirement: Claim→allowlist intersection is enforced on list and call
The gateway SHALL map JWT `scope` values to tool names using a claim→allowlist table. The tools a principal may list or call SHALL be the intersection of its registered allowlist and the tools granted by the presented scopes. A guessed or out-of-intersection tool name SHALL be denied with JSON-RPC `-32001` and SHALL NOT run.

#### Scenario: Scope intersection hides payments
- GIVEN principal `agt_payops` is registered for `echo.ping` and `stripe.charge`
- AND the Bearer JWT has scope `tools:echo` only
- WHEN the client sends `tools/list` with `mode=full`
- THEN the result includes `echo.ping`
- AND the result does not include `stripe.charge`

#### Scenario: Scope intersection denies a registered tool
- GIVEN the same principal and `tools:echo` only
- WHEN it calls `stripe.charge`
- THEN the gateway returns JSON-RPC `-32001`
- AND no charge runs

#### Scenario: Guessed tool name is denied
- GIVEN an authenticated principal
- WHEN it calls `vault.exfil`
- THEN the gateway returns JSON-RPC `-32001`

#### Scenario: Intersection allows when both sides grant
- GIVEN principal `agt_payops` and scopes `tools:echo tools:payments`
- WHEN it calls `echo.ping`
- THEN the tool runs
- AND the result carries the principal
