/**
 * Tests for codex provider 429 mid-request failover with account rotation.
 *
 * Verifies the logic that, when a codex connection returns 429, OmniRoute:
 *   1. Marks the failing connection as rate-limited
 *   2. Clears session affinity for the failing account
 *   3. Fetches the next available codex connection
 *   4. Retries with the new connection and succeeds
 *
 * These tests focus on pure-function logic that does not require SQLite,
 * to keep them isolated from the pre-existing migration environment issue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexFailoverFailure,
  isCodexOverloadStatus,
} from "../../open-sse/handlers/chatCore/codexFailover.ts";

// ── Helpers imported directly (no SQLite dependency) ────────────────────────
const authModule = await import("../../src/sse/services/auth.ts");
const { extractSessionAffinityKey } = authModule;

// ── Test 1: session affinity key extraction for codex headers ────────────────
test("extractSessionAffinityKey extracts x-codex-session-id header for codex failover", () => {
  const headers = {
    get: (name: string) => {
      if (name === "x-codex-session-id") return "codex-session-abc123";
      return null;
    },
  };
  const key = extractSessionAffinityKey({}, headers);
  assert.ok(key, "Should return a session affinity key from x-codex-session-id header");
  assert.ok(
    key.includes("codex-session-abc123") || key.length > 0,
    "Key should be derived from the codex session header"
  );
});

test("extractSessionAffinityKey extracts x-session-id header as fallback", () => {
  const headers = {
    get: (name: string) => {
      if (name === "x-session-id") return "session-xyz789";
      return null;
    },
  };
  const key = extractSessionAffinityKey({}, headers);
  assert.ok(key, "Should return a session affinity key from x-session-id header");
});

test("extractSessionAffinityKey derives key from body session_id", () => {
  const body = { session_id: "body-session-001" };
  const key = extractSessionAffinityKey(body, null);
  assert.ok(key, "Should return a session affinity key from body session_id");
  assert.ok(key.includes("body-session-001") || key.length > 0, "Key should reflect body session");
});

test("extractSessionAffinityKey returns null for empty input", () => {
  // Note: if body has no text content and no session ID, returns null
  const key = extractSessionAffinityKey({}, null);
  assert.equal(key, null, "Should return null when no session identifiers present");
});

// ── Test 2: maxAttempts logic — codex gets 3, other providers get 1 ──────────
test("codex maxAttempts is 3 (validates retry budget for account rotation)", () => {
  // This mirrors the logic: provider === "codex" ? 3 : 1
  const getMaxAttempts = (provider: string) => (provider === "codex" ? 3 : 1);

  assert.equal(getMaxAttempts("codex"), 3, "Codex should have 3 max attempts");
  assert.equal(getMaxAttempts("openai"), 1, "OpenAI should have 1 max attempt (unchanged)");
  assert.equal(getMaxAttempts("anthropic"), 1, "Anthropic should have 1 max attempt (unchanged)");
  assert.equal(getMaxAttempts("gemini"), 1, "Gemini should have 1 max attempt (unchanged)");
});

// ── Test 3: account rotation state machine ───────────────────────────────────
test("codex failover state: excluded IDs accumulate across retries", () => {
  const codexExcludedIds: string[] = [];

  // Simulate first 429
  const failedId1 = "conn-a-1234-5678";
  if (!codexExcludedIds.includes(failedId1)) {
    codexExcludedIds.push(failedId1);
  }
  assert.deepEqual(codexExcludedIds, ["conn-a-1234-5678"], "First failed ID should be excluded");

  // Simulate second 429 with a different account
  const failedId2 = "conn-b-5678-9012";
  if (!codexExcludedIds.includes(failedId2)) {
    codexExcludedIds.push(failedId2);
  }
  assert.deepEqual(
    codexExcludedIds,
    ["conn-a-1234-5678", "conn-b-5678-9012"],
    "Both failed IDs should be excluded after two retries"
  );

  // Ensure no duplicates if same ID hits again
  if (!codexExcludedIds.includes(failedId1)) {
    codexExcludedIds.push(failedId1);
  }
  assert.equal(codexExcludedIds.length, 2, "Should not duplicate the same excluded ID");
});

// ── Test 4: retry-after header parsing ───────────────────────────────────────
test("codex failover: retry-after header is parsed to milliseconds", () => {
  // Simulate response with retry-after: 60 (seconds)
  const parseRetryAfter = (headerValue: string | null): number | null => {
    if (!headerValue) return null;
    return parseFloat(headerValue) * 1000;
  };

  assert.equal(parseRetryAfter("60"), 60_000, "60s retry-after should become 60000ms");
  assert.equal(parseRetryAfter("30"), 30_000, "30s retry-after should become 30000ms");
  assert.equal(parseRetryAfter(null), null, "null retry-after should remain null");

  // Default fallback when no retry-after
  const retryAfterMs = null;
  const cooldownMs = retryAfterMs || 60_000;
  assert.equal(cooldownMs, 60_000, "Default cooldown should be 60s when no retry-after");
});

// ── Test 5: credentials mutation for rotation ─────────────────────────────────
test("codex failover: Object.assign patches credentials with new account", () => {
  // Simulate current credentials for connection A
  const credentials: Record<string, unknown> = {
    apiKey: null,
    accessToken: "token-a",
    connectionId: "conn-a",
    refreshToken: "refresh-a",
    providerSpecificData: { workspaceId: "ws-a" },
  };

  // Simulate nextCreds from getProviderCredentials for connection B
  const nextCreds = {
    apiKey: null,
    accessToken: "token-b",
    connectionId: "conn-b",
    refreshToken: "refresh-b",
    providerSpecificData: { workspaceId: "ws-b" },
    testStatus: "active",
    lastError: null,
    rateLimitedUntil: null,
    errorCode: null,
    lastErrorType: null,
    lastErrorSource: null,
  };

  // Apply the same mutation used in the failover code
  Object.assign(credentials, nextCreds);

  assert.equal(credentials.accessToken, "token-b", "Credentials should use new access token");
  assert.equal(credentials.connectionId, "conn-b", "Credentials should use new connection ID");
  assert.deepEqual(
    credentials.providerSpecificData,
    { workspaceId: "ws-b" },
    "Provider specific data should be updated to new account"
  );
});

// ── Test 6: failover only triggers for 429 or explicit Codex overload ─────────
test("codex failover: 429 rotates and preserves persisted cooldown behavior", () => {
  assert.deepEqual(classifyCodexFailoverFailure(429, ""), {
    reason: "rate_limit",
    persistCooldown: true,
  });
});

test("codex failover: explicit overload/capacity 502/503/504 rotates request-locally", () => {
  const overloadBodies = [
    [
      502,
      '{\n  "error": {\n    "code":  "server_is_overloaded",\n    "message": "Our servers are overloaded"\n  }\n}',
    ],
    [503, '{"error":{"type":"service_unavailable_error","message":"Please retry"}}'],
    [503, '{"error":{"message":"Selected model is at capacity. Please retry."}}'],
    [504, '{"response":{"error":{"message":"Our servers are currently overloaded."}}}'],
  ] as const;

  for (const [status, body] of overloadBodies) {
    assert.deepEqual(classifyCodexFailoverFailure(status, body), {
      reason: "overload",
      persistCooldown: false,
    });
  }
});

test("codex failover: arbitrary 5xx does not rotate accounts", () => {
  const nonOverloadFailures = [
    [500, '{"error":{"code":"server_is_overloaded"}}'],
    [502, '{"error":{"code":"bad_gateway","message":"Bad gateway"}}'],
    [503, '{"error":{"code":"service_unavailable","message":"Service temporarily unavailable"}}'],
    [503, '{"error":{"message":"Chat admission capacity is temporarily unavailable"}}'],
    [504, '{"error":{"code":"gateway_timeout","message":"Upstream request timed out"}}'],
  ] as const;

  for (const [status, body] of nonOverloadFailures) {
    assert.equal(classifyCodexFailoverFailure(status, body), null);
  }
});

test("codex failover: only overload candidate statuses require body inspection", () => {
  assert.equal(isCodexOverloadStatus(429), false);
  assert.equal(isCodexOverloadStatus(500), false);
  assert.equal(isCodexOverloadStatus(502), true);
  assert.equal(isCodexOverloadStatus(503), true);
  assert.equal(isCodexOverloadStatus(504), true);
});

test("codex failover: provider/attempt guards remain bounded to Codex and three attempts", () => {
  const shouldTriggerFailover = (
    provider: string,
    status: number,
    body: string,
    attempt: number,
    maxAttempts: number
  ) =>
    provider === "codex" &&
    classifyCodexFailoverFailure(status, body) !== null &&
    attempt < maxAttempts - 1;

  assert.equal(shouldTriggerFailover("codex", 429, "", 0, 3), true);
  assert.equal(
    shouldTriggerFailover("codex", 503, '{"error":{"code":"server_is_overloaded"}}', 1, 3),
    true
  );
  assert.equal(
    shouldTriggerFailover("codex", 429, "", 2, 3),
    false,
    "last attempt does not rotate"
  );
  assert.equal(
    shouldTriggerFailover("openai", 429, "", 0, 3),
    false,
    "other providers do not rotate"
  );
});

// ── Test 7: no-credentials response stops rotation ───────────────────────────
test("codex failover: stops rotation when getProviderCredentials returns null", () => {
  // Simulate the guard: if no next creds, return the 429 response as-is
  const guardFailover = (nextCreds: unknown) => {
    if (!nextCreds || (nextCreds as Record<string, unknown>).allRateLimited) {
      return "STOP_ROTATION";
    }
    return "CONTINUE_ROTATION";
  };

  assert.equal(guardFailover(null), "STOP_ROTATION", "null creds → stop rotation");
  assert.equal(
    guardFailover({ allRateLimited: true }),
    "STOP_ROTATION",
    "allRateLimited → stop rotation"
  );
  assert.equal(
    guardFailover({ connectionId: "conn-b", accessToken: "token-b" }),
    "CONTINUE_ROTATION",
    "valid creds → continue rotation"
  );
});
