import type { Json } from "@cubiczan/shared";

/** UTF-8 bytes per estimated token. Documented heuristic — not a vendor tokenizer. */
export const BYTES_PER_TOKEN = 4;

export interface TaxThresholds {
  toolTokens: number;
  packTokens: number;
  listTokens: number;
}

export const DEFAULT_TAX_THRESHOLDS: TaxThresholds = {
  toolTokens: 512,
  packTokens: 1024,
  listTokens: 2048,
};

export interface ToolTax {
  name: string;
  server: string;
  pack: string;
  bytes: number;
  tokens: number;
  descriptionBytes: number;
  descriptionTokens: number;
  schemaBytes: number;
  schemaTokens: number;
  oversized: boolean;
  oversizedDescription: boolean;
  oversizedSchema: boolean;
}

export interface PackTax {
  id: string;
  server?: string;
  toolCount: number;
  bytes: number;
  tokens: number;
  flagged: boolean;
  tools: string[];
}

export interface ServerTax {
  server: string;
  toolCount: number;
  bytes: number;
  tokens: number;
  flagged: boolean;
  tools: ToolTax[];
}

export interface ListTax {
  bytes: number;
  tokens: number;
  toolCount: number;
  fullAllowlistTokens: number;
  savedTokens: number;
  flagged: boolean;
  mode: "pack" | "full";
  warnings: string[];
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function estimateTokensFromBytes(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromBytes(utf8Bytes(text));
}

export function measureJson(value: unknown): { bytes: number; tokens: number } {
  const bytes = utf8Bytes(JSON.stringify(value));
  return { bytes, tokens: estimateTokensFromBytes(bytes) };
}

export function listedToolShape(tool: {
  name: string;
  description?: string;
  inputSchema?: Json;
}): { name: string; description: string; inputSchema: Json } {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object" },
  };
}

export function measureToolSchema(
  tool: {
    name: string;
    description?: string;
    inputSchema?: Json;
    server?: string;
    pack?: string;
  },
  toolThreshold = DEFAULT_TAX_THRESHOLDS.toolTokens,
): ToolTax {
  const listed = listedToolShape(tool);
  const { bytes, tokens } = measureJson(listed);
  const description = measureJson(listed.description);
  const schema = measureJson(listed.inputSchema);
  return {
    name: tool.name,
    server: tool.server ?? "governed-mcp-gateway",
    pack: tool.pack ?? "core",
    bytes,
    tokens,
    descriptionBytes: description.bytes,
    descriptionTokens: description.tokens,
    schemaBytes: schema.bytes,
    schemaTokens: schema.tokens,
    oversized: tokens >= toolThreshold,
    oversizedDescription: description.tokens >= toolThreshold,
    oversizedSchema: schema.tokens >= toolThreshold,
  };
}

export function sumTaxes(items: Array<{ bytes: number; tokens: number }>): { bytes: number; tokens: number } {
  return items.reduce(
    (acc, item) => ({ bytes: acc.bytes + item.bytes, tokens: acc.tokens + item.tokens }),
    { bytes: 0, tokens: 0 },
  );
}

export function maxMinRatio(values: number[]): number {
  const positive = values.filter((n) => n > 0);
  if (positive.length === 0) return 0;
  const max = Math.max(...positive);
  const min = Math.min(...positive);
  return Number((max / min).toFixed(2));
}

export function packTax(
  id: string,
  tools: ToolTax[],
  packThreshold = DEFAULT_TAX_THRESHOLDS.packTokens,
): PackTax {
  const { bytes, tokens } = sumTaxes(tools);
  return {
    id,
    toolCount: tools.length,
    bytes,
    tokens,
    flagged: tokens >= packThreshold || tools.some((t) => t.oversized),
    tools: tools.map((t) => t.name),
  };
}

export function groupByServer(tools: ToolTax[], packThreshold = DEFAULT_TAX_THRESHOLDS.packTokens): ServerTax[] {
  const groups = new Map<string, ToolTax[]>();
  for (const tool of tools) {
    const list = groups.get(tool.server) ?? [];
    list.push(tool);
    groups.set(tool.server, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, grouped]) => {
      const { bytes, tokens } = sumTaxes(grouped);
      return {
        server,
        toolCount: grouped.length,
        bytes,
        tokens,
        flagged: tokens >= packThreshold || grouped.some((t) => t.oversized),
        tools: grouped,
      };
    });
}
