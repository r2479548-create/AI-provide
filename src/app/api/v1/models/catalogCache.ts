/**
 * Response cache for `GET /v1/models`, extracted from catalog.ts.
 *
 * #6408 — concurrent catalog requests used to serialize (~1.2 s each × N). The
 * builder walks 8 registries and hits SQLite for connections, combos, custom
 * models and aliases; under Next.js's single-threaded App Router request
 * handling, N concurrent calls execute back-to-back and the Nth completes at
 * N × single-request latency. Identical concurrent requests are therefore
 * coalesced onto one in-flight promise and successful serialized bodies are
 * memoized for a short fresh window.
 *
 * Auth rejection is NOT handled here and must stay in the caller: it depends on
 * live per-request state (dashboard cookie, API key) and must never be cached.
 */
import { getModelCatalogCacheVersion } from "@/lib/db/readCache";
import { extractApiKey } from "@/sse/services/auth";
import { after } from "next/server";

import { isCodexModelCatalogClient } from "./catalogRequest";

export type CachedCatalog = {
  body: string;
  headers: Record<string, string>;
  status: number;
  expiresAt: number;
};

/** Payload shape returned by the shared builder primitive the caller injects. */
export type CatalogPayload = {
  body: string;
  headers: Record<string, string>;
  status: number;
  cacheTTL: number;
};

export type CatalogRefreshTask = () => Promise<void>;
export type CatalogRefreshScheduler = (task: CatalogRefreshTask) => void;

/**
 * Per-call cache policy. Request-context routes inject Next.js `after()` as the
 * scheduler; unit tests and direct non-framework callers can inject a deterministic
 * scheduler without making the cache branch on runner-specific environment variables.
 */
export type CatalogCachePolicy = {
  getStaleWhileRevalidateMs?: () => number;
  scheduleBackgroundRefresh?: CatalogRefreshScheduler;
};

/**
 * Production stale-while-revalidate window.
 *
 * A successful snapshot remains eligible indefinitely after the 60-second fresh TTL.
 * TTL expiry requests return that last success and schedule one refresh. Database state
 * changes are different: the version signal below hard-invalidates every snapshot and
 * makes the next request await a current-generation build.
 */
export const CATALOG_STALE_WHILE_REVALIDATE_MS = Number.POSITIVE_INFINITY;

/**
 * Fallback memoization window; overridden by `settings.cache.modelCatalogCacheTtlMs`.
 *
 * This is only the fresh window. Ordinary expiry serves the last successful snapshot
 * while refreshing. `modelCatalogCacheVersion` changes bypass stale serving entirely.
 */
export const CATALOG_CACHE_TTL_MS_DEFAULT = 60_000;

type CatalogInFlight = {
  generation: number;
  promise: Promise<CatalogPayload>;
};

const catalogCache = new Map<string, CachedCatalog>();
const catalogInFlight = new Map<string, CatalogInFlight>();

let catalogGeneration = 0;
let lastSeenCatalogCacheVersion = getModelCatalogCacheVersion();
let staleWhileRevalidateMsAccessor = () => CATALOG_STALE_WHILE_REVALIDATE_MS;
let _catalogBuilderRuns = 0;

function defaultBackgroundRefreshScheduler(task: CatalogRefreshTask): void {
  // All production routes run in Next.js request context, including callers that transform the
  // shared response. Direct test/startup callers have no request store and need a safe fallback.
  try {
    after(task);
  } catch {
    setImmediate(() => void task());
  }
}

/** Current SWR policy value; production defaults to unbounded stale serving. */
export function getCatalogStaleWhileRevalidateMs(): number {
  return staleWhileRevalidateMsAccessor();
}

function buildCatalogCacheKey(request: Request): string {
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || "";
  const apiKey = extractApiKey(request) || "";
  const isCodex = isCodexModelCatalogClient(request) ? "1" : "0";
  const configuredOnly = url.searchParams.get("configuredOnly") === "true" ? "1" : "0";
  return `${prefix}|${isCodex}|${apiKey}|${configuredOnly}`;
}

/**
 * Observe the DB-side invalidation signal.
 *
 * Every observed version transition is hard invalidation: snapshots are cleared,
 * the local generation advances, and old work is detached. Completion guards also
 * call this function, so a version change that occurs while a builder is running
 * prevents that builder from writing even before another request arrives.
 */
function synchronizeCatalogGeneration(): void {
  const currentVersion = getModelCatalogCacheVersion();
  if (currentVersion === lastSeenCatalogCacheVersion) return;

  lastSeenCatalogCacheVersion = currentVersion;
  catalogGeneration++;
  catalogCache.clear();
  catalogInFlight.clear();
}

// Header sources mix Title-Case keys (diagnostic/cors headers built by app code) with
// lower-case ones (payload headers captured via the Fetch `Headers` iterator). Merge
// through a real Headers so the caller's per-request diagnostics overwrite cached values
// case-insensitively.
export function mergeCatalogHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      merged.set(key, value);
    }
  }
  return merged;
}

function isSuccessfulPayload(payload: CatalogPayload): boolean {
  return payload.status >= 200 && payload.status < 300;
}

function storeSuccessfulPayload(
  cacheKey: string,
  payload: CatalogPayload,
  inFlight: CatalogInFlight
): void {
  synchronizeCatalogGeneration();
  if (!isSuccessfulPayload(payload)) return;
  if (inFlight.generation !== catalogGeneration) return;
  if (catalogInFlight.get(cacheKey) !== inFlight) return;

  catalogCache.set(cacheKey, {
    body: payload.body,
    headers: payload.headers,
    status: payload.status,
    expiresAt: Date.now() + payload.cacheTTL,
  });
}

function runBuilder(
  buildPayload: (request: Request) => Promise<CatalogPayload>,
  request: Request
): Promise<CatalogPayload> {
  _catalogBuilderRuns++;
  try {
    return Promise.resolve(buildPayload(request));
  } catch (error) {
    return Promise.reject(error);
  }
}

function cleanInFlight(cacheKey: string, inFlight: CatalogInFlight): void {
  if (catalogInFlight.get(cacheKey) === inFlight) {
    catalogInFlight.delete(cacheKey);
  }
}

function startSynchronousBuild(
  cacheKey: string,
  request: Request,
  buildPayload: (request: Request) => Promise<CatalogPayload>
): CatalogInFlight {
  const generation = catalogGeneration;
  let inFlight!: CatalogInFlight;
  const promise = runBuilder(buildPayload, request).then((payload) => {
    storeSuccessfulPayload(cacheKey, payload, inFlight);
    return payload;
  });
  inFlight = { generation, promise };
  catalogInFlight.set(cacheKey, inFlight);
  inFlight.promise.then(
    () => cleanInFlight(cacheKey, inFlight),
    () => cleanInFlight(cacheKey, inFlight)
  );
  return inFlight;
}

function scheduleBackgroundRefresh(
  cacheKey: string,
  request: Request,
  buildPayload: (request: Request) => Promise<CatalogPayload>,
  schedule: CatalogRefreshScheduler
): void {
  if (catalogInFlight.has(cacheKey)) return;

  let resolveRefresh!: (payload: CatalogPayload) => void;
  let rejectRefresh!: (error: unknown) => void;
  const inFlight: CatalogInFlight = {
    generation: catalogGeneration,
    promise: new Promise<CatalogPayload>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    }),
  };

  // Reserve the key before handing the task to the scheduler. Multiple stale reads in
  // the same request turn therefore cannot enqueue duplicate refreshes.
  catalogInFlight.set(cacheKey, inFlight);
  void inFlight.promise.catch(() => {}); // background failures are always handled

  const task: CatalogRefreshTask = async () => {
    synchronizeCatalogGeneration();
    if (inFlight.generation !== catalogGeneration || catalogInFlight.get(cacheKey) !== inFlight) {
      // Hard invalidation or a deterministic test reset detached this scheduled task
      // before it started. Resolve its private bookkeeping promise without rebuilding.
      resolveRefresh({ body: "", headers: {}, status: 204, cacheTTL: 0 });
      return;
    }

    try {
      const payload = await runBuilder(buildPayload, request);
      storeSuccessfulPayload(cacheKey, payload, inFlight);
      resolveRefresh(payload);
    } catch (error) {
      console.error("[catalog] Background stale-while-revalidate refresh failed:", error);
      rejectRefresh(error);
    } finally {
      cleanInFlight(cacheKey, inFlight);
    }
  };

  try {
    schedule(task);
  } catch (error) {
    cleanInFlight(cacheKey, inFlight);
    rejectRefresh(error);
    console.error("[catalog] Failed to schedule background refresh:", error);
  }
}

/**
 * Resolve the cached catalog response for `request`, building it through the shared
 * `buildPayload` primitive when there is no current snapshot.
 */
export async function resolveCachedCatalogResponse(
  request: Request,
  headerSources: { corsHeaders: Record<string, string>; diagnosticHeaders: Record<string, string> },
  buildPayload: (request: Request) => Promise<CatalogPayload>,
  policy: CatalogCachePolicy = {}
): Promise<Response> {
  const { corsHeaders, diagnosticHeaders } = headerSources;
  synchronizeCatalogGeneration();

  const cacheKey = buildCatalogCacheKey(request);
  const now = Date.now();
  const cached = catalogCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return new Response(cached.body, {
      status: cached.status,
      headers: mergeCatalogHeaders(corsHeaders, cached.headers, diagnosticHeaders),
    });
  }

  const staleWhileRevalidateMs =
    policy.getStaleWhileRevalidateMs?.() ?? getCatalogStaleWhileRevalidateMs();
  if (
    cached &&
    cached.status >= 200 &&
    cached.status < 300 &&
    now - cached.expiresAt <= staleWhileRevalidateMs
  ) {
    scheduleBackgroundRefresh(
      cacheKey,
      request,
      buildPayload,
      policy.scheduleBackgroundRefresh ?? defaultBackgroundRefreshScheduler
    );
    return new Response(cached.body, {
      status: cached.status,
      headers: mergeCatalogHeaders(corsHeaders, cached.headers, diagnosticHeaders),
    });
  }

  let inFlight = catalogInFlight.get(cacheKey);
  if (!inFlight) {
    inFlight = startSynchronousBuild(cacheKey, request, buildPayload);
  }

  const payload = await inFlight.promise;
  return new Response(payload.body, {
    status: payload.status,
    headers: mergeCatalogHeaders(corsHeaders, payload.headers, diagnosticHeaders),
  });
}

// ── Test hooks ───────────────────────────────────────────────────────────────
// Not part of the public application API.

/** Deterministically resets counters, policy, snapshots, generations, and old work. */
export function __resetCatalogBuilderRunsForTest(): void {
  _catalogBuilderRuns = 0;
  catalogGeneration++;
  catalogCache.clear();
  catalogInFlight.clear();
  lastSeenCatalogCacheVersion = getModelCatalogCacheVersion();
  staleWhileRevalidateMsAccessor = () => CATALOG_STALE_WHILE_REVALIDATE_MS;
}

/** Injects the SWR policy accessor without environment-dependent behavior. */
export function __setCatalogStaleWhileRevalidateAccessorForTest(accessor: () => number): void {
  staleWhileRevalidateMsAccessor = accessor;
}

/** Backward-compatible scalar policy hook retained for focused tests. */
export function __setCatalogStaleWhileRevalidateMsForTest(ms: number): void {
  staleWhileRevalidateMsAccessor = () => ms;
}

/** Counts full builder executions — proves concurrent requests share one run (#6408). */
export function __getCatalogBuilderRunsForTest(): number {
  return _catalogBuilderRuns;
}

/** Marks every successful snapshot expired without sleeping out the real TTL. */
export function __expireCatalogCacheForTest(msAgo = 1): void {
  const expiresAt = Date.now() - msAgo;
  for (const [key, entry] of catalogCache.entries()) {
    catalogCache.set(key, { ...entry, expiresAt });
  }
}

/** Seeds a request-keyed snapshot for status/staleness compatibility tests. */
export function __setCatalogCacheEntryForTest(request: Request, entry: CachedCatalog): void {
  catalogCache.set(buildCatalogCacheKey(request), entry);
}

/** Awaits any currently running or scheduled refresh without real-time sleeps. */
export async function __flushCatalogBackgroundRefreshForTest(): Promise<void> {
  await Promise.all([...catalogInFlight.values()].map(({ promise }) => promise.catch(() => {})));
}

/** Injects a handled in-flight rejection for the catalog error-shape regression test. */
export function __forceCatalogInFlightRejectionForTest(request: Request, error: unknown): void {
  const promise: Promise<CatalogPayload> = Promise.reject(error);
  void promise.catch(() => {});
  catalogInFlight.set(buildCatalogCacheKey(request), {
    generation: catalogGeneration,
    promise,
  });
}
