import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GATEWAY_AUDIENCE,
  mintBearerToken,
  scopePermits,
  verifyClaimToken,
} from "../src/auth.ts";

const key = "gateway-demo-key";

test("claim token verifies and rejects a flipped signature", () => {
  const token = mintBearerToken(key, {
    v: 1,
    sub: "agt_payops",
    aud: GATEWAY_AUDIENCE,
    scope: ["echo.ping"],
  });
  assert.equal(verifyClaimToken(token, key, GATEWAY_AUDIENCE).ok, true);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.deepEqual(verifyClaimToken(tampered, key, GATEWAY_AUDIENCE), {
    ok: false,
    reason: "invalid",
  });
});

test("mcp.invoke authorizes any tool; a named scope does not", () => {
  assert.equal(scopePermits(["mcp.invoke"], "stripe.charge"), true);
  assert.equal(scopePermits(["echo.ping"], "stripe.charge"), false);
});
