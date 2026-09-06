import { Buffer } from "node:buffer";
import { canonicalJson, hmacHex, safeEqual } from "@cubiczan/shared";

export const GATEWAY_AUDIENCE = "mcp://governed-gateway";
export const SCOPE_INVOKE = "mcp.invoke";
export const TOKEN_PREFIX = "czb1";

export type AuthDenyReason =
  | "missing"
  | "invalid"
  | "expired"
  | "wrong_audience"
  | "wrong_scope";

export interface BearerClaims {
  v: 1;
  sub: string;
  aud: string;
  scope: string[];
  exp?: number;
  iat?: number;
}

export type ClaimVerifyOk = { ok: true; claims: BearerClaims };
export type ClaimVerifyDenied = { ok: false; reason: AuthDenyReason };
export type ClaimVerifyResult = ClaimVerifyOk | ClaimVerifyDenied;

export function scopePermits(scopes: readonly string[], tool: string): boolean {
  return scopes.includes(SCOPE_INVOKE) || scopes.includes(tool);
}

export function intersectTools(allowlist: readonly string[], scopes: readonly string[]): string[] {
  return allowlist.filter((name) => scopePermits(scopes, name));
}

export function mintBearerToken(key: string, claims: BearerClaims): string {
  const payload = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  const sig = hmacHex(key, canonicalJson(claims));
  return `${TOKEN_PREFIX}.${payload}.${sig}`;
}

export function verifyClaimToken(
  token: string,
  key: string,
  expectedAudience: string,
  nowMs = Date.now(),
): ClaimVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid" };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.sub !== "string" || typeof raw.aud !== "string") {
    return { ok: false, reason: "invalid" };
  }
  if (!Array.isArray(raw.scope) || raw.scope.some((s) => typeof s !== "string")) {
    return { ok: false, reason: "invalid" };
  }
  const claims: BearerClaims = {
    v: 1,
    sub: raw.sub,
    aud: raw.aud,
    scope: raw.scope as string[],
  };
  if (typeof raw.exp === "number") claims.exp = raw.exp;
  if (typeof raw.iat === "number") claims.iat = raw.iat;

  const expected = hmacHex(key, canonicalJson(claims));
  if (!safeEqual(expected, parts[2])) return { ok: false, reason: "invalid" };
  if (claims.aud !== expectedAudience) return { ok: false, reason: "wrong_audience" };
  if (typeof claims.exp === "number" && claims.exp * 1000 <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

export function denyScopeIfRequired(
  scopes: readonly string[],
  requiredScope?: string,
): AuthDenyReason | undefined {
  if (!requiredScope) return undefined;
  if (!scopePermits(scopes, requiredScope)) return "wrong_scope";
  return undefined;
}
