import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseScopeClaim,
  signHs256Jwt,
  verifyHs256Jwt,
  type JwtClaims,
  type JwtFailReason,
  type Principal,
} from "@cubiczan/shared";

export interface ScopeToolMapping {
  scope: string;
  tools: string[];
}

export interface ClaimAllowlistFixture {
  audience: string;
  issuer: string;
  hmacSecret: string;
  algorithm: "HS256";
  mappings: ScopeToolMapping[];
  cases: Record<string, ClaimTokenRecipe>;
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

export type BearerFailReason = "missing" | JwtFailReason;

export type BearerAuthResult =
  | { ok: true; principal: Principal; source: "api-key" | "jwt" }
  | { ok: false; reason: BearerFailReason };

export function loadClaimAllowlistFixture(): ClaimAllowlistFixture {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../test/fixtures/claim-allowlist.json");
  return JSON.parse(readFileSync(path, "utf8")) as ClaimAllowlistFixture;
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
  principal: Principal,
  mappings: ScopeToolMapping[],
): string[] {
  if (principal.scopes === undefined) return registered;
  return intersectAllowlist(registered, toolsForScopes(principal.scopes, mappings));
}

export function mintFixtureJwt(
  fixture: ClaimAllowlistFixture,
  recipe: ClaimTokenRecipe,
  nowMs = Date.now(),
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const claims: JwtClaims = {
    sub: recipe.sub,
    aud: recipe.aud ?? fixture.audience,
    iss: recipe.iss ?? fixture.issuer,
    iat: nowSec,
    exp: nowSec + (recipe.expOffsetSec ?? 3600),
    scope: recipe.scope ?? "",
  };
  if (recipe.nbfOffsetSec !== undefined) claims.nbf = nowSec + recipe.nbfOffsetSec;
  return signHs256Jwt(claims, fixture.hmacSecret);
}

export function verifyFixtureJwt(
  token: string,
  fixture: ClaimAllowlistFixture,
  now?: () => number,
): { ok: true; claims: JwtClaims } | { ok: false; reason: JwtFailReason } {
  return verifyHs256Jwt(token, {
    secret: fixture.hmacSecret,
    audience: fixture.audience,
    issuer: fixture.issuer,
    now,
  });
}

export function principalFromJwtClaims(
  base: Principal,
  claims: JwtClaims,
): Principal {
  return {
    ...base,
    scopes: parseScopeClaim(claims.scope),
  };
}
