/**
 * In-memory claim → tool allowlist seed for the demo gateway.
 *
 * Do not read `test/fixtures/claim-allowlist.json` at runtime. After esbuild
 * emits `dist/web.mjs`, `import.meta.url` is the bundle (`/var/task/dist/…`)
 * so a relative `../test/fixtures/…` path becomes `/var/task/test/fixtures/…`,
 * which Fluid does not ship (`includeFiles` is `dist/**`).
 */

export interface ScopeToolMapping {
  scope: string;
  tools: string[];
}

export interface ClaimTokenRecipe {
  sub: string;
  aud?: string;
  iss?: string;
  scope?: string;
  expOffsetSec?: number;
  nbfOffsetSec?: number;
  call?: string;
}

export interface ClaimAllowlistSeed {
  audience: string;
  issuer: string;
  hmacSecret: string;
  algorithm: "HS256";
  mappings: ScopeToolMapping[];
  cases: Record<string, ClaimTokenRecipe>;
}

export const DEFAULT_CLAIM_ALLOWLIST: ClaimAllowlistSeed = {
  audience: "mcp://governed-gateway",
  issuer: "https://issuer.cubiczan.test",
  hmacSecret: "gateway-jwt-demo-hmac",
  algorithm: "HS256",
  mappings: [
    { scope: "tools:echo", tools: ["echo.ping"] },
    { scope: "tools:payments", tools: ["stripe.charge"] },
    { scope: "tools:search", tools: ["search.web"] },
  ],
  cases: {
    validPayops: {
      sub: "agt_payops",
      scope: "tools:echo tools:payments",
      expOffsetSec: 3600,
    },
    echoOnly: {
      sub: "agt_payops",
      scope: "tools:echo",
      expOffsetSec: 3600,
    },
    expired: {
      sub: "agt_payops",
      scope: "tools:echo",
      expOffsetSec: -60,
    },
    wrongAud: {
      sub: "agt_payops",
      aud: "mcp://other-gateway",
      scope: "tools:echo",
      expOffsetSec: 3600,
    },
    guessedTool: {
      sub: "agt_payops",
      scope: "tools:echo",
      expOffsetSec: 3600,
      call: "vault.exfil",
    },
    intersectDeny: {
      sub: "agt_payops",
      scope: "tools:echo",
      expOffsetSec: 3600,
      call: "stripe.charge",
    },
    intersectAllow: {
      sub: "agt_payops",
      scope: "tools:echo tools:payments",
      expOffsetSec: 3600,
      call: "echo.ping",
    },
  },
};

export function defaultClaimAllowlist(): ClaimAllowlistSeed {
  return structuredClone(DEFAULT_CLAIM_ALLOWLIST);
}

export function loadClaimAllowlistFixture(): ClaimAllowlistSeed {
  return defaultClaimAllowlist();
}

export function toolsForScopes(scopes: string[], mappings: ScopeToolMapping[]): string[] {
  const granted = new Set<string>();
  const table = new Map(mappings.map((row) => [row.scope, row.tools]));
  for (const scope of scopes) {
    for (const tool of table.get(scope) ?? []) granted.add(tool);
  }
  return [...granted];
}

export function intersectAllowlist(allowlist: string[], scoped: string[]): string[] {
  const allowed = new Set(scoped);
  return allowlist.filter((name) => allowed.has(name));
}

export function effectiveAllowlist(
  registered: string[],
  scopes: string[] | undefined,
  mappings: ScopeToolMapping[],
): string[] {
  if (scopes === undefined) return registered;
  return intersectAllowlist(registered, toolsForScopes(scopes, mappings));
}
