/**
 * GenericMemoryBackend - Generic HTTP connector for any memory backend
 * Connects to external memory backends via REST API
 * Supports Obsidian, Notion, custom backends, etc.
 */

import { logger } from "../../../open-sse/utils/logger.ts";
import type {
  MemoryBackend,
  CreateMemoryInput,
  MemoryFilter,
  SearchConfig,
  HealthCheckResult,
  Memory,
} from "./backend";
import { MemoryType } from "./types";
const log = logger("GENERIC_MEMORY_BACKEND");

export interface GenericBackendConfig {
  /** Base URL of the memory backend API */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Request timeout in ms */
  timeout?: number;
  /** Backend type identifier for logging */
  backendType?: string;

  /** ─── Dynamic endpoint templates (NEW) ───
   *  Supports placeholders: {id}, {dbId}, {memoryId}, etc.
   *  If omitted, defaults to REST conventions below.
   */
  endpoints?: {
    /** GET /memories?query=... */
    search?: string; // default: "/memories/search"
    /** POST /memories */
    create?: string; // default: "/memories"
    /** GET /memories */
    list?: string; // default: "/memories"
    /** GET /memories/{id} */
    get?: string; // default: "/memories/{id}"
    /** PATCH /memories/{id} */
    update?: string; // default: "/memories/{id}"
    /** DELETE /memories/{id} */
    delete?: string; // default: "/memories/{id}"
    /** GET /health */
    health?: string; // default: "/health"
  };

  /** ─── Query parameter name mapping (NEW) ───
   *  Maps internal param names → backend-specific names
   */
  queryParams?: {
    query?: string; // default: "query"
    apiKeyId?: string; // default: "apiKeyId"
    limit?: string; // default: "limit"
    offset?: string; // default: "offset"
    strategy?: string; // default: "strategy"
    maxTokens?: string; // default: "maxTokens"
    type?: string; // default: "type"
    sessionId?: string; // default: "sessionId"
    orderBy?: string; // default: "orderBy"
    orderDir?: string; // default: "orderDir"
    options?: string; // default: "options"
  };

  /** ─── Path parameter name mapping (NEW) ───
   *  Maps internal placeholder names → backend-specific names
   */
  pathParams?: {
    id?: string; // default: "id"
    memoryId?: string; // default: "memoryId"
  };
}

export class GenericMemoryBackend implements MemoryBackend {
  readonly id: string;
  readonly displayName: string;

  private config: GenericBackendConfig;
  private initialized = false;

  constructor(id: string, displayName: string, config: GenericBackendConfig) {
    this.id = id;
    this.displayName = displayName;
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    const healthy = await this.health();
    if (!healthy.ok) {
      throw new Error(
        `Cannot connect to ${this.displayName} at ${this.config.baseUrl}: ${healthy.error}`
      );
    }
    this.initialized = true;
    log.info("generic.backend.initialized", { id: this.id, baseUrl: this.config.baseUrl });
  }

  private getEndpoints() {
    return {
      search: this.config.endpoints?.search ?? "/memories/search",
      create: this.config.endpoints?.create ?? "/memories",
      list: this.config.endpoints?.list ?? "/memories",
      get: this.config.endpoints?.get ?? "/memories/{id}",
      update: this.config.endpoints?.update ?? "/memories/{id}",
      delete: this.config.endpoints?.delete ?? "/memories/{id}",
      health: this.config.endpoints?.health ?? "/health",
    };
  }

  private getQueryParams() {
    return {
      query: this.config.queryParams?.query ?? "query",
      apiKeyId: this.config.queryParams?.apiKeyId ?? "apiKeyId",
      limit: this.config.queryParams?.limit ?? "limit",
      offset: this.config.queryParams?.offset ?? "offset",
      strategy: this.config.queryParams?.strategy ?? "strategy",
      maxTokens: this.config.queryParams?.maxTokens ?? "maxTokens",
      type: this.config.queryParams?.type ?? "type",
      sessionId: this.config.queryParams?.sessionId ?? "sessionId",
      orderBy: this.config.queryParams?.orderBy ?? "orderBy",
      orderDir: this.config.queryParams?.orderDir ?? "orderDir",
      options: this.config.queryParams?.options ?? "options",
    };
  }

  private getPathParams() {
    return {
      id: this.config.pathParams?.id ?? "id",
      memoryId: this.config.pathParams?.memoryId ?? "memoryId",
    };
  }

  /** Resolve endpoint template with path params */
  private resolveEndpoint(template: string, params: Record<string, string> = {}): string {
    return template.replace(/{(\w+)}/g, (_, key) => params[key] ?? `{${key}}`);
  }

  /** Build query params from SearchConfig using mapped names */
  private buildSearchQuery(config: SearchConfig): Record<string, string> {
    const qp = this.getQueryParams();
    const out: Record<string, string> = {};

    out[qp.query] = config.query;
    out[qp.apiKeyId] = config.apiKeyId;
    if (config.limit) out[qp.limit] = String(config.limit);
    if (config.maxTokens) out[qp.maxTokens] = String(config.maxTokens);
    if (config.strategy) out[qp.strategy] = config.strategy;
    if (config.options) out[qp.options] = JSON.stringify(config.options);

    return out;
  }

  /** Build query params from MemoryFilter using mapped names */
  private buildListQuery(filter: MemoryFilter): Record<string, string> {
    const qp = this.getQueryParams();
    const out: Record<string, string> = {};

    if (filter.apiKeyId) out[qp.apiKeyId] = filter.apiKeyId;
    if (filter.type) out[qp.type] = filter.type;
    if (filter.sessionId) out[qp.sessionId] = filter.sessionId;
    if (filter.limit !== undefined) out[qp.limit] = String(filter.limit);
    if (filter.offset !== undefined) out[qp.offset] = String(filter.offset);
    if (filter.orderBy) out[qp.orderBy] = filter.orderBy;
    if (filter.orderDir) out[qp.orderDir] = filter.orderDir;

    return out;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  // ─── CRUD ───

  async create(input: CreateMemoryInput): Promise<Memory> {
    if (!this.initialized) await this.initialize();

    const endpoint = this.resolveEndpoint(this.getEndpoints().create);
    const memory = await this.request<Memory>("POST", endpoint, input);
    return memory;
  }

  async get(id: string): Promise<Memory | null> {
    if (!this.initialized) await this.initialize();

    const pathParams = this.getPathParams();
    const endpoint = this.resolveEndpoint(this.getEndpoints().get, {
      [pathParams.id]: id,
      [pathParams.memoryId]: id,
    });

    try {
      return await this.request<Memory>("GET", endpoint);
    } catch (e) {
      if (String(e).includes("404")) return null;
      throw e;
    }
  }

  async update(id: string, updates: Partial<Omit<Memory, "id" | "createdAt">>): Promise<boolean> {
    if (!this.initialized) await this.initialize();

    const pathParams = this.getPathParams();
    const endpoint = this.resolveEndpoint(this.getEndpoints().update, {
      [pathParams.id]: id,
      [pathParams.memoryId]: id,
    });

    try {
      await this.request("PATCH", endpoint, updates);
      return true;
    } catch (e) {
      if (String(e).includes("404")) return false;
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!this.initialized) await this.initialize();

    const pathParams = this.getPathParams();
    const endpoint = this.resolveEndpoint(this.getEndpoints().delete, {
      [pathParams.id]: id,
      [pathParams.memoryId]: id,
    });

    try {
      await this.request("DELETE", endpoint);
      return true;
    } catch (e) {
      if (String(e).includes("404")) return false;
      throw e;
    }
  }

  async list(
    filter: MemoryFilter
  ): Promise<{ data: Memory[]; total: number; byType: Record<string, number> }> {
    if (!this.initialized) await this.initialize();

    const endpoint = this.getEndpoints().list;
    const queryParams = this.buildListQuery(filter);

    return this.request<{ data: Memory[]; total: number; byType: Record<string, number> }>(
      "GET",
      endpoint,
      undefined,
      queryParams
    );
  }

  // ─── Search ───

  async search(config: SearchConfig): Promise<Memory[]> {
    if (!this.initialized) await this.initialize();

    const endpoint = this.getEndpoints().search;
    const queryParams = this.buildSearchQuery(config);

    return this.request<Memory[]>("GET", endpoint, undefined, queryParams);
  }

  // ─── Health ───

  async health(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const endpoint = this.getEndpoints().health;
      await this.request<{ status: string }>("GET", endpoint);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: String(e) };
    }
  }
}

/** Factory function to create a generic memory backend */
export const createGenericMemoryBackend = (
  id: string,
  displayName: string,
  config: GenericBackendConfig
): GenericMemoryBackend => new GenericMemoryBackend(id, displayName, config);

/** Predefined configurations for known backends */
export const KNOWN_BACKENDS = {
  obsidian: {
    id: "obsidian",
    displayName: "Obsidian Vault",
    config: {
      baseUrl: process.env.OBSIDIAN_API_URL || "http://localhost:27123",
      apiKey: process.env.OBSIDIAN_API_KEY,
      backendType: "obsidian",
    } as GenericBackendConfig,
  },
  notion: {
    id: "notion",
    displayName: "Notion",
    config: {
      baseUrl: process.env.NOTION_API_URL || "https://api.notion.com/v1",
      apiKey: process.env.NOTION_API_KEY,
      backendType: "notion",
      headers: {
        "Notion-Version": "2022-06-28",
      },
    } as GenericBackendConfig,
  },
} as const;

export type KnownBackendId = keyof typeof KNOWN_BACKENDS;

/** Create a known backend from presets */
export const createKnownBackend = (id: KnownBackendId): GenericMemoryBackend => {
  const preset = KNOWN_BACKENDS[id];
  return createGenericMemoryBackend(preset.id, preset.displayName, preset.config);
};
