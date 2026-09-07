import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  sub: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  scope?: string;
  [key: string]: unknown;
}

export type JwtFailReason = "invalid" | "expired" | "wrong_aud" | "wrong_iss";

export interface JwtVerifyOk {
  ok: true;
  claims: JwtClaims;
}

export interface JwtVerifyFail {
  ok: false;
  reason: JwtFailReason;
}

export interface JwtVerifyOptions {
  secret: string;
  audience: string;
  issuer?: string;
  now?: () => number;
}

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

function parseB64urlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function signHs256Jwt(claims: JwtClaims, secret: string): string {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function audList(aud: string | string[] | undefined): string[] {
  if (!aud) return [];
  return Array.isArray(aud) ? aud : [aud];
}

export function verifyHs256Jwt(token: string, options: JwtVerifyOptions): JwtVerifyOk | JwtVerifyFail {
  if (!looksLikeJwt(token)) return { ok: false, reason: "invalid" };
  const [headerPart, payloadPart, sigPart] = token.split(".");
  const expected = createHmac("sha256", options.secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(sigPart);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: "invalid" };
  }

  const header = parseB64urlJson(headerPart) as { alg?: string; typ?: string } | undefined;
  const payload = parseB64urlJson(payloadPart) as JwtClaims | undefined;
  if (!header || header.alg !== "HS256" || !payload || typeof payload.sub !== "string" || !payload.sub) {
    return { ok: false, reason: "invalid" };
  }

  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  if (typeof payload.nbf === "number" && nowSec < payload.nbf) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.exp !== "number" || nowSec >= payload.exp) {
    return { ok: false, reason: "expired" };
  }

  const audiences = audList(payload.aud);
  if (!audiences.includes(options.audience)) {
    return { ok: false, reason: "wrong_aud" };
  }

  if (options.issuer && payload.iss !== options.issuer) {
    return { ok: false, reason: "wrong_iss" };
  }

  return { ok: true, claims: payload };
}

export function parseScopeClaim(scope: unknown): string[] {
  if (typeof scope === "string") return scope.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === "string" && s.length > 0);
  return [];
}
