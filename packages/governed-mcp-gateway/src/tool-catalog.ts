import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export function loadOversizedFixtureRecipe(): OversizedFixtureRecipe {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../test/fixtures/oversized-schema.json");
  return JSON.parse(readFileSync(path, "utf8")) as OversizedFixtureRecipe;
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
      description: "Governed echo. Returns the arguments and the calling principal.",
      pack: "core",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        message: { type: "string", description: "Optional ping payload." },
      }),
    },
    {
      name: "stripe.charge",
      description: "Simulated charge. Spend-plane hook may run when amountCents > 0.",
      pack: "payments",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        amountCents: { type: "integer", minimum: 0, description: "Charge amount in integer cents." },
      }),
    },
    {
      name: "search.web",
      description: "Governed web search stub.",
      pack: "research",
      server: DEFAULT_SERVER,
      inputSchema: objectSchema({
        query: { type: "string", description: "Search query." },
      }),
    },
    {
      name: "context.inspect",
      description: "Inspect the current session pack, schema token tax, and estate flags.",
      pack: "catalog",
      server: DEFAULT_SERVER,
      meta: true,
      inputSchema: objectSchema({
        sessionId: { type: "string", description: "Optional session id; defaults to ses_<principal>." },
        includeEstate: { type: "boolean", description: "Include the full catalog estate in the report." },
      }),
    },
    {
      name: "context.need",
      description: "Admit allowlisted tools or a named pack into this session (allow-by-need).",
      pack: "catalog",
      server: DEFAULT_SERVER,
      meta: true,
      inputSchema: objectSchema({
        sessionId: { type: "string" },
        tools: { type: "array", items: { type: "string" }, description: "Tool names to admit." },
        pack: { type: "string", description: "Named pack to admit (intersected with the allowlist)." },
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
