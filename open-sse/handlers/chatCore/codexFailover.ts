import { getCodexModelScope } from "../../config/codexQuotaScopes.ts";
import { updateProviderConnection } from "@/lib/db/providers";
import { getCachedProviderConnectionById } from "@/lib/localDb";

type CodexFailoverCredentials = {
  connectionId?: string | null;
  providerSpecificData?: unknown;
};

export type CodexFailoverDecision =
  { reason: "rate_limit"; persistCooldown: true } | { reason: "overload"; persistCooldown: false };

const CODEX_OVERLOAD_CODES = [
  "server_is_overloaded",
  "service_unavailable_error",
  "model_at_capacity",
  "model_capacity",
] as const;

const CODEX_OVERLOAD_MESSAGES = [
  /\bservers?\s+(?:are\s+|is\s+)?(?:currently\s+|temporarily\s+)?overloaded\b/i,
  /\bselected model is at capacity\b/i,
  /\bmodel\s+(?:is\s+)?(?:currently\s+|temporarily\s+)?at capacity\b/i,
] as const;

export function isCodexOverloadStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Classify the narrow Codex failures that may rotate to another OAuth account.
 *
 * A 429 preserves the existing persisted account/scope cooldown semantics.
 * A 502/503/504 only qualifies when its body explicitly identifies Codex
 * overload/model capacity. Those failures are upstream-wide rather than proof
 * that an account is bad, so the failed connection is excluded only from the
 * current request and no cooldown is persisted.
 */
export function classifyCodexFailoverFailure(
  status: number,
  responseBody: string
): CodexFailoverDecision | null {
  if (status === 429) {
    return { reason: "rate_limit", persistCooldown: true };
  }
  if (!isCodexOverloadStatus(status)) return null;

  const body = String(responseBody || "");
  const explicitCode = /"(?:code|type)"\s*:\s*"([^"]+)"/gi;
  const hasExplicitCode = Array.from(body.matchAll(explicitCode), (match) =>
    String(match[1]).toLowerCase()
  ).some((value) => CODEX_OVERLOAD_CODES.some((code) => value === code));
  const hasExplicitMessage = CODEX_OVERLOAD_MESSAGES.some((pattern) => pattern.test(body));

  return hasExplicitCode || hasExplicitMessage
    ? { reason: "overload", persistCooldown: false }
    : null;
}

function asProviderData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function markCodexScopeRateLimited(params: {
  failedConnectionId: string;
  model: string | null;
  rateLimitedUntil: string;
  credentials?: CodexFailoverCredentials | null;
}): Promise<void> {
  const connection = await getCachedProviderConnectionById(params.failedConnectionId).catch(
    () => null
  );
  const existingProviderData = connection
    ? asProviderData(connection.providerSpecificData)
    : asProviderData(params.credentials?.providerSpecificData);
  const existingScopeMap = asProviderData(existingProviderData.codexScopeRateLimitedUntil);
  const nextProviderData = {
    ...existingProviderData,
    codexScopeRateLimitedUntil: {
      ...existingScopeMap,
      [getCodexModelScope(params.model || "")]: params.rateLimitedUntil,
    },
  };

  updateProviderConnection(params.failedConnectionId, {
    ...(connection ? { providerSpecificData: nextProviderData } : {}),
    lastError: "429 rate limited — codex account rotation",
    errorCode: 429,
  }).catch(() => {});

  if (params.credentials && String(params.credentials.connectionId) === params.failedConnectionId) {
    params.credentials.providerSpecificData = nextProviderData;
  }
}
