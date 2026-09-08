# Glama release — Cubiczan/governed-mcp-gateway

Score page: https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/score

A Glama release is **not** a GitHub release. Tool Definition Quality and Server Coherence stay unscored until a maintainer claims the listing, syncs GitHub, builds the Dockerfile spec, and publishes a Glama release.

Repo files this listing needs:

| File | Role |
|---|---|
| [`glama.json`](../glama.json) | Claim file. Schema is only `maintainers` (GitHub usernames). Pattern matches Cubiczan/chp-mcp (`icohangar-ops`) plus `Cubiczan`. |
| [`Dockerfile`](../Dockerfile) | Local/self-host image. Glama often **generates** its own image; still keep this file so admin can paste CMD/build steps. |
| `packages/governed-mcp-gateway/src/mcp.ts` | Stdio JSON-RPC entry. Glama wraps CMD with `mcp-proxy --`. |
| `api/index.mjs` + `vercel.json` + `dist/web.mjs` | Optional **remote connector** (stateless Streamable HTTP on Vercel Fluid Compute). Install is `npm ci && npm run build`; the Fluid entry imports compiled JS, not runtime `tsx`. Glama health-checks `https://$VERCEL_URL/mcp` with Bearer auth. Not a substitute for the stdio Dockerfile build. |
| `packages/governed-mcp-gateway/package.json` | `repository` is `https://github.com/Cubiczan/governed-mcp-gateway`. |

Cubiczan-only URLs. Do not use icohangar-ops GitHub URLs on this listing.

## Sam — exact UI steps

Authenticate on Glama with GitHub as **`icohangar-ops`** (the username in `glama.json`). `Cubiczan` can claim too.

### 1. Claim

1. Open https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/score
2. If the page says **Author not verified** / **Looking for Admin?**, click **Claim** (Score tab or the unclaimed-server admin prompt).
3. Glama must see root `glama.json` with your GitHub username in `maintainers`. If claim fails: wait for merge of this PR, then continue at step 2.

### 2. Sync Server

1. Open the MCP server **admin** interface for Cubiczan/governed-mcp-gateway.
2. Click **Sync Server**.
3. Confirm the profile now shows **Has valid glama.json** and **Author verified**.
4. Do not skip this after merging `glama.json` — daily auto-sync is too slow for the awesome-mcp-servers badge check.

### 3. Dockerfile Build

1. Open https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/admin/dockerfile
2. If the form generates a Dockerfile (no raw `FROM` editor), set:

   | Field | Value |
   |---|---|
   | Base image | default (`debian:trixie-slim`) or leave as-is |
   | Node.js version | default (Node 22) |
   | **Build steps** | `["npm ci --no-audit --no-fund"]` |
   | **CMD arguments** | `["node", "--import", "tsx", "packages/governed-mcp-gateway/src/mcp.ts"]` |
   | Environment variables JSON schema | `{"properties":{},"required":[],"type":"object"}` |
   | Placeholder parameters | `{}` |
   | Pinned commit SHA | **empty** (HEAD after Sync) |

3. If the UI has a Dockerfile text field instead, paste the repo [`Dockerfile`](../Dockerfile).
4. Click **Build** (some UIs label this **Deploy**). Wait until the build test is green. The child must speak MCP stdio as **NDJSON on stdout**; `mcp-proxy` wraps CMD as `["mcp-proxy","--","node","--import","tsx","packages/governed-mcp-gateway/src/mcp.ts"]`. Content-Length framing is legacy stdin only — do not emit it on stdout.

Do **not** point CMD at `src/server.ts`. That process is HTTP on `127.0.0.1:7474` and will fail introspection.

### 4. Make Release

1. When the build test succeeds, click **Make Release** beside that test (or **Create Release** on the test detail page).
2. **Build & Release** on the Dockerfile page does both and picks the version for you.
3. If asked for a version, use `0.1.0` (matches the package) and publish.
4. Confirm https://glama.ai/mcp/servers/Cubiczan/governed-mcp-gateway/score shows **Has a Glama release**, then Tool Definition Quality and Server Coherence grades (B or above is passing).

Optional: **Try in Browser** on the server page once to seed usage.

## Local check (no Glama account)

```bash
npm ci
node --import tsx packages/governed-mcp-gateway/src/mcp.ts
```

Stdio stdout is **NDJSON** (`JSON.stringify(message)` plus a newline). Glama `mcp-proxy@6.4.3` parses newline-delimited JSON and **ignores** `Content-Length` header lines, which previously caused initialize timeouts. Stdin still accepts both NDJSON and legacy Content-Length framing. `npm start` / `npm run gateway` still serve HTTP `:7474`. `npm run mcp:http:smoke` curls `/health` then Bearer `initialize`. For a Glama **remote** connector after a Vercel import, use `https://$VERCEL_URL/mcp` and `Authorization: Bearer $GATEWAY_AGENT_KEY`. Never commit a deployment hostname.
