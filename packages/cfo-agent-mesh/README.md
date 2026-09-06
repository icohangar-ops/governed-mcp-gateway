# Auditable CFO Agent Mesh

Port **7476**. Every board claim traces to an **agent**, a **CHP lock**, and a **document**.

Controllers are not on Stack Overflow. This is the enterprise SKU: a claim will not seal until the pack has an agent id, `lockState: "LOCKED"`, and at least one source document SHA-256. Engines **measure**. They do not decide facts of law.

![Platform: CFO mesh is the evidence plane](docs/screenshots/architecture.png)

Engines:

- **ASC 842** lease classification + ROU / liability rollforward
- **ASC 606** cost-to-cost / constrained transaction price
- **ASC 718** grant ledger + period expense (RSU straight-line in the demo)

Token spend events attach as sources on the same HMAC-chained ledger (`ledgerOk: true` on seal).

## Live behavior

![LOCKED without documents still cannot seal](docs/screenshots/cfo-unsealed.png)

![Sealed pack: agent, lock, hashed register, HMAC preview](docs/screenshots/cfo-evidence.png)

![Finance lease, 24 months, IBR 6%, closing liability 0.00](docs/screenshots/cfo-lease.png)

## Run

From the platform root:

```bash
npm install
npm test -w @cubiczan/cfo-agent-mesh
npm run cfo
```

Open a claim, attach a register, lock as the controller, attach a lease engine, then seal:

```bash
# claim
curl -sS -H "Authorization: Bearer cfo_agt_lease_demo" \
  -H "Content-Type: application/json" \
  -d '{"title":"AI spend is $12.00 this period","narrative":"Token ledger supports the board claim.","agentId":"agt_lease"}' \
  http://127.0.0.1:7476/v1/claims

# document
curl -sS -H "Content-Type: application/json" \
  -d '{"name":"lease-register.csv","content":"L-1,warehouse,24000\n"}' \
  http://127.0.0.1:7476/v1/claims/clm_…/documents

# human lock
curl -sS -H "Authorization: Bearer cfo_human_controller_demo" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://127.0.0.1:7476/v1/claims/clm_…/lock

# ASC 842
curl -sS -H "Content-Type: application/json" \
  -d '{"claimId":"clm_…","leaseId":"L-1","periods":24,"amount":1000,"annualIbr":0.06,"transfersOwnership":true}' \
  http://127.0.0.1:7476/v1/engines/lease

# evidence pack
curl -sS http://127.0.0.1:7476/v1/evidence/clm_…
```

A lock without documents still fails:

```text
GET /v1/evidence/:id  ->  400  {"error":"claim has no source documents"}
```

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, service }` |
| `POST` | `/v1/claims` | Agent | Open claim (`EXPLORING`) |
| `POST` | `/v1/claims/:id/documents` | — | Name + content; store SHA-256 |
| `POST` | `/v1/claims/:id/tokens` | — | Model / token / cents source |
| `POST` | `/v1/claims/:id/lock` | Human | Agents cannot lock |
| `POST` | `/v1/engines/lease` | — | ASC 842 rollforward; optional `claimId` |
| `POST` | `/v1/engines/revenue` | — | ASC 606 constrained POC |
| `POST` | `/v1/engines/sbc` | — | ASC 718 period expense |
| `GET` | `/v1/evidence/:id` | — | Seal + HMAC chain verify |

Demo keys: `cfo_agt_lease_demo`, `cfo_human_controller_demo`.

## Layout

```
packages/cfo-agent-mesh/src/mesh.ts           claims, lock, seal, HTTP
packages/cfo-agent-mesh/src/engines/lease.ts  ASC 842
packages/cfo-agent-mesh/src/engines/revenue.ts ASC 606
packages/cfo-agent-mesh/src/engines/sbc.ts    ASC 718
packages/shared                               HMAC ledger, CHP types
```

Sister SKUs: [governed-mcp-gateway](https://github.com/icohangar-ops/governed-mcp-gateway) (`:7474`), [spend-mandate-plane](https://github.com/icohangar-ops/spend-mandate-plane) (`:7475`).

## License

MIT
