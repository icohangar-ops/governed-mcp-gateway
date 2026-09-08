# Tasks

## 1. Spec and compile

- [x] 1.1 OpenSpec proposal, design, and mcp-gateway spec delta
- [x] 1.2 `scripts/build-vercel.mjs` esbuild bundle → `dist/web.mjs`
- [x] 1.3 Root `build` / `build:vercel` scripts + esbuild dependency

## 2. Vercel Fluid entry

- [x] 2.1 `api/index.mjs` imports `../dist/web.mjs` (no `tsx`, no `.ts`)
- [x] 2.2 `vercel.json` install + build run `npm run build`, includeFiles `dist/**`, keep rewrites + fluid + maxDuration 60

## 3. Proof and docs

- [x] 3.1 Tests: no runtime tsx; compiled entry serves `/health` and Bearer initialize
- [x] 3.2 README notes for Vercel Install / Build commands
