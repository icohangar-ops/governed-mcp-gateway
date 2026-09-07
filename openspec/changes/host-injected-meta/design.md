# Design: host-injected `_meta` and tax polish

## Decisions

1. **`arguments` are the model's; `_meta` is the host's.** Tenant, index, and vaulted credential names are never LLM-chosen. The gateway binds them onto `params._meta.cubiczan.host` after auth. Listed `inputSchema` MUST NOT advertise those keys.

2. **Principal.orgId is the tenant ceiling.** `X-Cubiczan-Tenant`, `?tenant=`, or `_meta.cubiczan.host.tenant` may confirm `principal.orgId`. A different value is denied (`host.meta.denied`). Conflicting claims across header/query/meta are denied.

3. **Index is host-chosen, not model-chosen.** Bound from `X-Cubiczan-Index`, `?index=`, or `_meta.cubiczan.host.index`. Tools that declare `hostOnly: ["index"]` fail closed when the index is missing. A model-supplied `arguments.index` is invented and denied.

4. **Vaulted inputs stay named and secretless.** `_meta.cubiczan.host.vault.github_token` carries `{ name, version }` only. The VS Code input id does not change on rotate. `arguments.github_token` / `secret` / `apiKey` are host-only and denied.

5. **Impersonation is denied, not silently overwritten.** If `_meta.cubiczan.principal.id` or `.orgId` disagrees with the Bearer principal, the call is denied. Matching or omitted client principal is replaced with the authoritative object.

6. **Invented host keys fail closed.** Any host-only key in `arguments` (static set plus registered vault names plus the tool's `hostOnly` list) yields JSON-RPC `-32006` and ledger `host.meta.denied`. Keys are stripped from the argument object so a future relax cannot leak them into the impl.

7. **Tax split is heuristic, not a vendor tokenizer.** `tokens = ceil(utf8_bytes / 4)` still. Each tool records description vs `inputSchema` bytes/tokens so an oversized flag can point at schema bloat (the usual tax) versus a verbose description.

## Binding sources (first non-empty; conflict → deny)

| Param | Sources |
|---|---|
| `tenant` | Bearer `principal.orgId` (authoritative). Header / query / host `_meta` may only match. |
| `index` | `X-Cubiczan-Index`, `?index=`, `_meta.cubiczan.host.index` |
| `vault` | Gateway credential store (names + versions) |
| `principal` | Bearer only |

## Host-only argument keys

`tenant`, `tenantId`, `tenant_id`, `orgId`, `org_id`, `index`, `indexName`, `index_name`, `apiKey`, `api_key`, `secret`, `credential`, `github_token`, `principal`, `principalId`, `principal_id`, `accessToken`, `access_token`, plus every registered vault name.

## Demo tool

`index.query` (pack `tenant`) — schema is `{ query }`. Tenant and index come from host bindings. Allowlisted for PayOps and research so the cookbook can call it; it is **not** in the default session pack (`core` + catalog only).
