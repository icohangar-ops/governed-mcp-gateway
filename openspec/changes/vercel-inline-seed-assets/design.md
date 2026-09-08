# Design: inline seed for the Fluid handler

## Current state

`api/index.mjs` imports compiled `dist/web.mjs`. That bundle is esbuild of `packages/governed-mcp-gateway/src/web.ts` → `createSeededGateway()` → `new GovernedGateway()` → catalog/seed loaders.

Two loaders used `fileURLToPath(import.meta.url)` and `../test/fixtures/*.json`:

1. `loadOversizedFixtureRecipe()` (catalog). Had a try/catch fallback, so it would not 500, but it still attempted a Fluid-invalid path.
2. `loadClaimAllowlistFixture()` (constructor, cookbook / production graph). No fallback. After bundling, `import.meta.url` is `file:///var/task/dist/web.mjs`, so the read is `/var/task/test/fixtures/claim-allowlist.json` — the observed ENOENT.

`vercel.json` `includeFiles: dist/**` is correct for the compiled handler. Shipping `test/fixtures/**` into the lambda would paper over a test-path dependency. Production seed is tiny and static.

## Decisions

1. **Inline, do not includeFiles.** Demo allowlist mappings and the oversized schema recipe are TypeScript constants next to the code that uses them. esbuild inlines them into `dist/web.mjs`. No extra Fluid files.

2. **Constructor always takes the in-memory seed.** `GovernedGateway` stores `claims` from `options.claimFixture ?? defaultClaimAllowlist()`. `createSeededGateway()` / `seededWebGateway()` therefore cannot ENOENT on a missing JSON file, including when `cwd` is `/var/task` with no `test/` tree.

3. **Keep the on-disk oversized fixture as a documented copy.** `test/fixtures/oversized-schema.json` stays for humans and token-tax docs. Tests assert it matches the in-source recipe. Runtime never opens it.

4. **No hostname, no tsx, no JWT merge.** Fluid entry, rewrites, Bearer opaque keys, and `public/` outputDirectory stay as they are. Signed JWT claim verification remains a separate change.

## Trade-offs

- In-source seed duplicates the JSON cookbook fixture. That is cheaper than a second packaged asset path and avoids `import.meta.url` after bundle.
- `includeFiles: "test/fixtures/**"` would fix ENOENT with less code movement, but it keeps production coupled to a test directory and still breaks if the relative path is rewritten to `/var/task/test/fixtures` without also placing files there.

## Non-goals

- Merging the principal-on-RPC JWT cookbook.
- Changing Glama stdio Dockerfile/CMD.
- Live Stripe / x402.
- Hardcoding a Vercel hostname.
