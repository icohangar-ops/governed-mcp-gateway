import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BYTES_PER_TOKEN,
  DEFAULT_TAX_THRESHOLDS,
  estimateTokens,
  estimateTokensFromBytes,
  groupByServer,
  maxMinRatio,
  measureJson,
  measureToolSchema,
  packTax,
} from "../src/token-tax.ts";
import {
  buildOversizedCatalogTool,
  builtInCatalog,
  loadOversizedFixtureRecipe,
  toListedTool,
} from "../src/tool-catalog.ts";

test("bytes-to-token heuristic is ceil(utf8/4)", () => {
  assert.equal(BYTES_PER_TOKEN, 4);
  assert.equal(estimateTokensFromBytes(0), 0);
  assert.equal(estimateTokensFromBytes(1), 1);
  assert.equal(estimateTokensFromBytes(4), 1);
  assert.equal(estimateTokensFromBytes(5), 2);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("measureJson matches JSON.stringify byte length", () => {
  const value = { name: "echo.ping", inputSchema: { type: "object" } };
  const measured = measureJson(value);
  assert.equal(measured.bytes, Buffer.byteLength(JSON.stringify(value), "utf8"));
  assert.equal(measured.tokens, Math.ceil(measured.bytes / 4));
});

test("synthetic oversized fixture is flagged and dwarfs core tools", () => {
  const recipe = loadOversizedFixtureRecipe();
  assert.equal(recipe.name, "docs.mega_schema");
  assert.equal(recipe.server, "synthetic.oversized");
  assert.equal(recipe.pack, "bloat");

  const mega = buildOversizedCatalogTool(recipe);
  const echo = builtInCatalog().find((t) => t.name === "echo.ping");
  assert.ok(echo);
  const megaTax = measureToolSchema(mega, DEFAULT_TAX_THRESHOLDS.toolTokens);
  const echoTax = measureToolSchema(echo, DEFAULT_TAX_THRESHOLDS.toolTokens);
  assert.equal(megaTax.oversized, true);
  assert.equal(megaTax.oversizedSchema, true);
  assert.equal(echoTax.oversized, false);
  assert.ok(megaTax.schemaTokens > megaTax.descriptionTokens);
  assert.ok(megaTax.tokens / echoTax.tokens > 100, `ratio ${megaTax.tokens}/${echoTax.tokens}`);

  const estate = builtInCatalog().map((t) => measureToolSchema(t));
  const servers = groupByServer(estate);
  const ratio = maxMinRatio(servers.map((s) => s.tokens));
  assert.ok(ratio > 100, `estate ratio ${ratio}`);
  const bloat = packTax("bloat", estate.filter((t) => t.pack === "bloat"));
  assert.equal(bloat.flagged, true);
});

test("listed shape is name + description + inputSchema only", () => {
  const mega = buildOversizedCatalogTool();
  const listed = toListedTool(mega);
  assert.deepEqual(Object.keys(listed).sort(), ["description", "inputSchema", "name"]);
  assert.equal(listed.name, "docs.mega_schema");
});

test("listed index.query schema strips host-only tenant and index", () => {
  const tool = builtInCatalog().find((item) => item.name === "index.query");
  assert.ok(tool);
  const listed = toListedTool(tool);
  const properties = (listed.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.deepEqual(Object.keys(properties).sort(), ["query"]);
  assert.ok(!("tenant" in properties));
  assert.ok(!("index" in properties));
});
