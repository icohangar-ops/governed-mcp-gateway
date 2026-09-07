# Tasks

## 1. Spec and host-meta primitive

- [x] 1.1 OpenSpec proposal, design, and mcp-gateway spec deltas
- [x] 1.2 Host-only key set, bind/claim helpers, schema strip
- [x] 1.3 Description vs schema token-tax fields

## 2. Gateway

- [x] 2.1 Bind `_meta.cubiczan.host` + authoritative principal on `tools/call`
- [x] 2.2 Deny invented host-only arguments, tenant mismatch, impersonation
- [x] 2.3 Catalog `index.query` (pack `tenant`); hide host-only keys on `tools/list`
- [x] 2.4 Fail-closed auth unchanged on inspector and JSON-RPC

## 3. Proof

- [x] 3.1 Negative tests: invented tenant/key, header mismatch, impersonation, unauthenticated tax
- [x] 3.2 Pack-by-need + estate tax tests still green
- [x] 3.3 README cookbook (pack, need, tax, host `_meta`, vaulted inputs)
