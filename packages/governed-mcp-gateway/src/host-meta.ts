import type { Json, Principal } from "@cubiczan/shared";

/** Identifiers the model must not choose. Host binds them on `_meta`. */
export const HOST_ONLY_ARGUMENT_KEYS = [
  "tenant",
  "tenantId",
  "tenant_id",
  "orgId",
  "org_id",
  "index",
  "indexName",
  "index_name",
  "apiKey",
  "api_key",
  "secret",
  "credential",
  "github_token",
  "principal",
  "principalId",
  "principal_id",
  "accessToken",
  "access_token",
] as const;

export interface HostVaultBinding {
  name: string;
  version: number;
}

export interface HostBindings {
  tenant: string;
  index?: string;
  vault: Record<string, HostVaultBinding>;
}

export interface HostClaimInput {
  header?: string;
  query?: string;
  meta?: string;
}

export type HostBindResult =
  | { ok: true; host: HostBindings }
  | { ok: false; reason: string; invented: string[] };

function trimClaim(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function isHostOnlyKey(key: string, extra: Iterable<string> = []): boolean {
  if ((HOST_ONLY_ARGUMENT_KEYS as readonly string[]).includes(key)) return true;
  for (const item of extra) {
    if (item === key) return true;
  }
  return false;
}

export function hostOnlyKeySet(extra: Iterable<string> = []): Set<string> {
  return new Set<string>([...HOST_ONLY_ARGUMENT_KEYS, ...extra]);
}

/** Single host claim, or deny when header / query / `_meta` disagree. */
export function resolveHostClaim(claim: HostClaimInput, name: string): { ok: true; value?: string } | { ok: false; reason: string } {
  const values = [claim.header, claim.query, claim.meta].map(trimClaim).filter((value) => value.length > 0);
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    return { ok: false, reason: `conflicting host ${name} claims` };
  }
  return { ok: true, value: unique[0] };
}

export function bindHostBindings(input: {
  principal: Principal;
  tenantClaim?: HostClaimInput;
  indexClaim?: HostClaimInput;
  vault: Iterable<{ name: string; version: number }>;
}): HostBindResult {
  const tenantClaim = resolveHostClaim(input.tenantClaim ?? {}, "tenant");
  if (!tenantClaim.ok) {
    return { ok: false, reason: tenantClaim.reason, invented: ["tenant"] };
  }
  if (tenantClaim.value && tenantClaim.value !== input.principal.orgId) {
    return {
      ok: false,
      reason: `host tenant ${tenantClaim.value} does not match principal.orgId ${input.principal.orgId}`,
      invented: ["tenant"],
    };
  }

  const indexClaim = resolveHostClaim(input.indexClaim ?? {}, "index");
  if (!indexClaim.ok) {
    return { ok: false, reason: indexClaim.reason, invented: ["index"] };
  }

  const vault: Record<string, HostVaultBinding> = {};
  for (const cred of input.vault) {
    vault[cred.name] = { name: cred.name, version: cred.version };
  }

  return {
    ok: true,
    host: {
      tenant: input.principal.orgId,
      index: indexClaim.value,
      vault,
    },
  };
}

export function claimedPrincipalConflict(
  principal: Principal,
  claimed: { id?: unknown; orgId?: unknown } | undefined,
): string | undefined {
  if (!claimed) return undefined;
  if (typeof claimed.id === "string" && claimed.id && claimed.id !== principal.id) {
    return `params._meta.cubiczan.principal.id ${claimed.id} does not match ${principal.id}`;
  }
  if (typeof claimed.orgId === "string" && claimed.orgId && claimed.orgId !== principal.orgId) {
    return `params._meta.cubiczan.principal.orgId ${claimed.orgId} does not match ${principal.orgId}`;
  }
  return undefined;
}

export function inventedHostKeys(
  args: Record<string, Json>,
  extra: Iterable<string> = [],
): string[] {
  const blocked = hostOnlyKeySet(extra);
  return Object.keys(args).filter((key) => blocked.has(key));
}

export function stripHostOnlyKeys(
  args: Record<string, Json>,
  extra: Iterable<string> = [],
): { arguments: Record<string, Json>; stripped: string[] } {
  const blocked = hostOnlyKeySet(extra);
  const next: Record<string, Json> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (blocked.has(key)) {
      stripped.push(key);
      continue;
    }
    next[key] = value;
  }
  return { arguments: next, stripped };
}

export function stripHostOnlyFromSchema(schema: Json, extra: Iterable<string> = []): Json {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const blocked = hostOnlyKeySet(extra);
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const nextProps: Record<string, Json> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!blocked.has(key)) nextProps[key] = value;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string" && !blocked.has(item))
    : undefined;
  return {
    ...schema,
    properties: nextProps,
    ...(required ? { required } : {}),
  };
}
