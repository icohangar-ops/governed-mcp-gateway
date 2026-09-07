# Streamable HTTP on more than one replica

Inspired by [Stack Overflow 79962720](https://stackoverflow.com/questions/79962720) (Spring AI MCP MVC Streamable HTTP on Kubernetes). Do **not** treat in-process session maps as a cluster. Cubiczan ships three operator choices so you never get replica affinity by accident.

The failure, in one picture:

```
Client  --initialize-->  Replica A   mints Mcp-Session-Id=abc123  (in-process Map)
Client  --tools/call-->  Service / Ingress  --round-robin-->  Replica B
Replica B has no abc123  →  empty 200, hang, or a vague 404
```

This gateway's Bearer principal is already stamped on every `tools/call` and SSE frame. That is enough identity for STATELESS. Pack-by-need (`params.need` / `params.pack` on the **same** `tools/list`) is request-scoped. What is *not* cluster-safe is an in-process `ContextPackStore` plus a minted `Mcp-Session-Id` with no store and no affinity.

| Mode | Env | When to use | When not to |
|---|---|---|---|
| **STATELESS** (default) | `MCP_SESSION_MODE=stateless` | Production HA. Any replica can serve `tools/list` and `tools/call` after auth. | You need server-push subscriptions that only exist in a JVM/Node session object. |
| **Sticky ingress** | `MCP_SESSION_MODE=sticky` | Short-lived demos, or an ingress that hashes `Mcp-Session-Id` / a cookie to one ready pod. | Rolling deploys, scale-in, node drain, multi-AZ failover. The owning pod goes away and the id dies. |
| **Externalize** | `MCP_SESSION_MODE=shared` | You must keep a durable pack / transport session and run 2+ replicas. | You have not actually shared the store (two local Maps is still sticky). |

`GET /health` reports `{ sessionMode, replicaId }` so a probe can see what you deployed.

```bash
curl -sS http://127.0.0.1:7474/health
```

Set `MCP_REPLICA_ID` (or rely on Kubernetes `HOSTNAME`) so mismatch errors name the pod.

---

## 1. Fail-closed STATELESS (preferred)

No `Mcp-Session-Id` is minted. `tools/list` and `tools/call` use the Bearer principal already injected as `params._meta.cubiczan.principal`. Missing credentials are still HTTP 401. Allowlist and CHP are unchanged.

```bash
export MCP_SESSION_MODE=stateless   # default if unset
npm run gateway

# initialize — no Mcp-Session-Id header
curl -sS -D - -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  http://127.0.0.1:7474/mcp | head

# tools/list on any replica — pass pack/need on this request if you need more than the seed
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"pack":"payments"}}' \
  http://127.0.0.1:7474/mcp

# tools/call — principal is host-injected; no session header
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo.ping","arguments":{"hello":"any-replica"}}}' \
  http://127.0.0.1:7474/mcp
```

Durable admit-by-need across replicas is **not** implied. `POST /v1/context/need` writes the local (or injected) `SessionStore`. In STATELESS production, send `params.pack` / `params.need` on each `tools/list`, or run `shared` mode with a real shared store.

---

## 2. Sticky ingress (acceptable only with eyes open)

`initialize` mints `Mcp-Session-Id` and binds it to `replicaId`. Later calls **must** send that header. If the id is missing: `MISSING_SESSION` (HTTP 400). If this pod does not own it: `SESSION_STICKY_MISMATCH` (HTTP 404). Both are JSON-RPC `-32020` with `data.reason` — never a silent empty 200.

```bash
export MCP_SESSION_MODE=sticky
export MCP_REPLICA_ID=gw-a
npm run gateway
```

```bash
# Mint
SID=$(curl -sS -D - -o /tmp/mcp-init.json \
  -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  http://127.0.0.1:7474/mcp | awk -F': ' 'tolower($1)=="mcp-session-id"{gsub(/\r/,"",$2); print $2}')

# Same replica — OK
curl -sS -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://127.0.0.1:7474/mcp

# Missing header — MISSING_SESSION
curl -sS -D - -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' \
  http://127.0.0.1:7474/mcp

# Stale / other replica — SESSION_STICKY_MISMATCH
curl -sS -D - -H "Authorization: Bearer mcp_agt_payops_demo" \
  -H "Mcp-Session-Id: mcp_stale_from_dead_pod" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo.ping"}}' \
  http://127.0.0.1:7474/mcp
```

### Kubernetes / ingress notes

Cookie affinity (NGINX Ingress) pins a *browser* to a pod. MCP clients are not browsers. Prefer hashing the session header, and still accept that deploys break the pin.

```yaml
# Service: do not assume this is enough. ClusterIP is round-robin.
apiVersion: v1
kind: Service
metadata:
  name: governed-mcp-gateway
spec:
  selector:
    app: governed-mcp-gateway
  ports:
    - name: http
      port: 7474
      targetPort: 7474
---
# Ingress cookie affinity — acceptable for a demo; not HA.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: governed-mcp-gateway
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "cubiczan_mcp_replica"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "300"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-change-on-failure: "true"
spec:
  rules:
    - host: mcp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: governed-mcp-gateway
                port:
                  number: 7474
```

Header-hash (when your proxy supports it), for example Envoy / NGINX plus:

```nginx
# Hash the transport session, not the client IP (NAT collapses agents).
upstream mcp_gateway {
  hash $http_mcp_session_id consistent;
  server gw-a.mcp.svc.cluster.local:7474;
  server gw-b.mcp.svc.cluster.local:7474;
}
```

**Rolling deploys / scale-in.** A sticky cookie or header hash that still points at a terminating pod is a `SESSION_STICKY_MISMATCH`. Clients must `initialize` again. Connection draining does not resurrect an in-process `Map`. If you cannot tolerate that, do not use this mode.

---

## 3. Externalize the session (shared store)

Any replica can serve the next `tools/call` when they share a `SessionStore`. CI uses `InMemorySessionStore` or `KeyValueSessionStore` + `MapRedisLike`. Production wraps a Redis-compatible client; tests never open a network Redis.

```ts
import { GovernedGateway, KeyValueSessionStore } from "@cubiczan/governed-mcp-gateway";

const store = new KeyValueSessionStore({
  get: (key) => redis.get(key),
  set: (key, value) => void redis.set(key, value),
  del: (key) => void redis.del(key),
});

const gateway = new GovernedGateway({
  sessionMode: "shared",
  replicaId: process.env.HOSTNAME,
  sessionStore: store,
});
```

Unknown id on a shared store is `UNKNOWN_SESSION` (HTTP 404 + JSON-RPC `-32020`), not a successful empty list.

```bash
export MCP_SESSION_MODE=shared
# Inject the same SessionStore in every replica process (see constructor above).
```

Proof without Redis (what CI runs): two `GovernedGateway` instances, one `InMemorySessionStore`. `initialize` on A, `tools/list` / `tools/call` on B with that `Mcp-Session-Id` — HTTP 200, principal still on `_meta`.

---

## Reason codes

| `data.reason` | HTTP | Meaning |
|---|---|---|
| `MISSING_SESSION` | 400 | Sticky/shared required a `Mcp-Session-Id` and none was sent. |
| `SESSION_STICKY_MISMATCH` | 404 | Sticky mode: unknown on this replica, or `replicaId` does not match. |
| `UNKNOWN_SESSION` | 404 | Shared store miss (stale id after expiry or never written). |
| `SESSION_PRINCIPAL_MISMATCH` | 400 | Bearer principal does not own the session. |

These names match silent-probe style codes (`MISSING_SESSION`, `SESSION_STICKY_MISMATCH`) so a probe can assert a reason instead of sniffing body text.

Example error (never an empty 200):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32020,
    "message": "MCP session is unknown on this replica",
    "data": {
      "reason": "SESSION_STICKY_MISMATCH",
      "replicaId": "gw-b",
      "mode": "sticky",
      "sessionId": "mcp_…",
      "hint": "Session was minted on another replica or the replica was replaced. Re-run initialize, enable a shared SessionStore, or switch to STATELESS."
    }
  }
}
```

Terminate a sticky/shared session with `DELETE /mcp` and the same `Mcp-Session-Id`.

---

## What this gateway already guarantees

- Fail-closed Bearer auth (HTTP 401, no tool runs).
- Claim → allowlist: `tools/call` for a tool not on the principal list is JSON-RPC `-32001`.
- Pack-by-need remains fail-closed against that allowlist.
- Host-injected `_meta.cubiczan.principal` on every `tools/call` and SSE frame.

See OpenSpec: [`openspec/changes/streamable-http-multi-replica/`](../openspec/changes/streamable-http-multi-replica/).
