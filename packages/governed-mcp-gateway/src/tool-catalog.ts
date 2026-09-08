import type { Json, Principal } from "@cubiczan/shared";
import { listedToolShape, measureToolSchema, type ToolTax, type TaxThresholds } from "./token-tax.ts";

export const META_TOOLS = ["context.inspect", "context.need"] as const;
export const DEFAULT_SERVER = "governed-mcp-gateway";

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Json;
  pack: string;
  server: string;
  meta?: boolean;
}

export interface OversizedFixtureRecipe {
  name: string;
  description: string;
  server: string;
  pack: string;
  expansion: {
    propertyCount: number;
    enumSize: number;
    descriptionPad: number;
  };
}

/** In-source recipe. Do not read `test/fixtures/oversized-schema.json` at runtime (Fluid cwd has no test tree). */
export const OVERSIZED_SCHEMA_RECIPE: OversizedFixtureRecipe = {
  name: "docs.mega_schema",
  description:
    "Synthetic oversized MCP tool schema. Inspiration: measured tools/list cost can vary ~1700x across servers; this fixture makes that tax visible.",
  server: "synthetic.oversized",
  pack: "bloat",
  expansion: {
    propertyCount: 450,
    enumSize: 20,
    descriptionPad: 220,
  },
};

export function loadOversizedFixtureRecipe(): OversizedFixtureRecipe {
  return structuredClone(OVERSIZED_SCHEMA_RECIPE);
}

export function expandOversizedInputSchema(recipe: OversizedFixtureRecipe): Json {
  const { propertyCount, enumSize, descriptionPad } = recipe.expansion;
  const pad = "tax".repeat(Math.ceil(descriptionPad / 3)).slice(0, descriptionPad);
  const properties: Record<string, Json> = {};
  for (let i = 0; i < propertyCount; i += 1) {
    const idx = String(i).padStart(2, "0");
    properties[`field_${idx}`] = {
      type: "string",
      description: `${pad} field ${idx} — verbose enum used only to inflate tools/list context tax.`,
      enum: Array.from({ length: enumSize }, (_, j) => `value_${idx}_${String(j).padStart(2, "0")}_${"y".repeat(12)}`),
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["field_00"],
  };
}

export function buildOversizedCatalogTool(recipe = loadOversizedFixtureRecipe()): CatalogTool {
  return {
    name: recipe.name,
    description: recipe.description,
    inputSchema: expandOversizedInputSchema(recipe),
    pack: recipe.pack,
    server: recipe.server,
  };
}

const objectSchema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

let cachedOversized: CatalogTool | undefined;

function oversizedCatalogTool(): CatalogTool {
  cachedOversized ??= buildOversizedCatalogTool();
  return cachedOversized;
}

export function builtInCatalog(): CatalogTool[] {
  return [
    {
      name: "echo.ping",
      description:
        "Identity probe. Echoes the call arguments and the authenticated Principal the gateway injected onto this tools/call (id, kind, org). Use it to confirm Bearer identity survived onto the tool worker. Does not hit a network, mutate vault state, or charge. Idempotent except for an audit-ledger append. Not a substitute for context.inspect.",
      pack: "core",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        message: {
          type: "string",
          description: "Optional ping payload echoed back in the result. Omit to send an empty ping.",
        },
      }),
    },
    {
      name: "stripe.charge",
      description:
        "Simulated payment tool. amountCents is integer cents. Under the demo auto-cap this returns a simulated charge plus the Principal; it never calls live Stripe. Not on the default tools/list pack — admit it with context.need (pack=payments) first. Research principals are denied JSON-RPC -32001. Over cap the gateway returns pending_human instead of charging. Optional spend-plane hook runs only when SPEND_PLANE_URL is set and amountCents > 0.",
      pack: "payments",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        amountCents: {
          type: "integer",
          minimum: 0,
          description: "Charge amount in integer cents (not dollars). 0 is a no-op simulated charge.",
        },
      }),
    },
    {
      name: "search.web",
      description:
        "Governed web-search stub for the research principal. Returns an empty hits array plus the query and Principal. Does not call a live search API. Not on the PayOps allowlist or the default session pack — admit with context.need (pack=research) when the caller is allowlisted. Use echo.ping to test identity; use this only when you need a research-shaped tool.",
      pack: "research",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        query: { type: "string", description: "Search query string. Required for a useful stub result." },
      }),
    },
    {
      name: "context.inspect",
      description:
        "Read the current session pack and schema token-tax report for the authenticated principal. Returns the bytes→tokens heuristic, session tool names, savedTokens versus the full allowlist, and (unless includeEstate=false) the estate including oversized flags. Does not admit tools and does not execute other tools. Call this before context.need to see what is already loaded. Fail-closed: requires the same principal as the session.",
      pack: "catalog",
      server: DEFAULT_SERVER,
      meta: true,
      inputSchema: objectSchema({
        sessionId: {
          type: "string",
          description: "Optional session id; defaults to ses_<principalId> when omitted.",
        },
        includeEstate: {
          type: "boolean",
          description: "When false, omit the full catalog estate and return only session tax. Default true.",
        },
      }),
    },
    {
      name: "context.need",
      description:
        "Admit extra tools or a named pack into this session (allow-by-need). Always intersected with the principal allowlist — fail-closed. Research cannot admit stripe.charge. Does not run the admitted tools; call tools/list afterwards to see the new pack, or context.inspect to see tax. sessionId defaults to ses_<principalId>. Denied names are returned in denied[] and recorded on the ledger.",
      pack: "catalog",
      server: DEFAULT_SERVER,
      meta: true,
      inputSchema: objectSchema({
        sessionId: {
          type: "string",
          description: "Optional session id; defaults to ses_<principalId> when omitted.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Concrete tool names to admit (e.g. stripe.charge). Ignored when not allowlisted.",
        },
        pack: {
          type: "string",
          description: "Named pack to admit (catalog, core, payments, research). Intersected with the allowlist.",
        },
      }),
    },
    oversizedCatalogTool(),
  ];
}

export function isMetaTool(name: string): boolean {
  return (META_TOOLS as readonly string[]).includes(name);
}

export function toListedTool(tool: CatalogTool): { name: string; description: string; inputSchema: Json } {
  return listedToolShape(tool);
}

export function catalogTaxes(tools: CatalogTool[], thresholds: TaxThresholds): ToolTax[] {
  return tools.map((tool) => measureToolSchema(tool, thresholds.toolTokens));
}

export function namesInPack(tools: Iterable<CatalogTool>, pack: string): string[] {
  return [...tools].filter((tool) => tool.pack === pack).map((tool) => tool.name);
}

export function defaultSeedTools(allowlist: string[], catalog: Iterable<CatalogTool>): string[] {
  const allowed = new Set(allowlist);
  const seed = new Set<string>(META_TOOLS);
  for (const tool of catalog) {
    if (tool.pack === "core" && allowed.has(tool.name)) seed.add(tool.name);
  }
  return [...seed];
}

export function canExpose(name: string, allowlist: string[]): boolean {
  return isMetaTool(name) || allowlist.includes(name);
}

export type ToolImpl = (args: Record<string, Json>, principal: Principal) => Json;
