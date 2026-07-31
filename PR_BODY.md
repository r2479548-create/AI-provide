# feat(memory): MemoryBackend Provider Pattern with Generic HTTP Connector

## Summary

Introduces a pluggable **MemoryBackend** provider architecture with a **generic HTTP connector** that supports dynamic endpoint/query/path mapping for any REST-based memory backend (Obsidian, Notion, custom).

## Changes

### Core Architecture (Phases 1-3)

| File                               | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/lib/memory/backend.ts`        | `MemoryBackend` interface + `CreateMemoryInput`, `MemoryFilter`, `SearchConfig`, `HealthCheckResult` |
| `src/lib/memory/manager.ts`        | `MemoryManager` singleton — register, configure, fallback routing, health checks                     |
| `src/lib/memory/sqliteBackend.ts`  | Thin wrapper around existing `store.ts`/`retrieval.ts` — implements `MemoryBackend`                  |
| `src/lib/memory/index.ts`          | Exports + auto-registers SQLiteBackend + `initMemoryBackends()` for app bootstrap                    |
| `src/app/api/memory/route.ts`      | Delegates to `memoryManager.list()` / `memoryManager.create()`                                       |
| `src/app/api/memory/[id]/route.ts` | Delegates to `memoryManager.get/delete/update()`                                                     |

### Optional Backends (Phase 4)

| File                                | Description                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `src/lib/memory/genericBackend.ts`  | **Generic HTTP connector** with dynamic endpoint/query/path mapping                  |
| `src/lib/memory/obsidianBackend.ts` | Obsidian vault file-based backend (markdown + YAML frontmatter)                      |
| `src/lib/memory/settings.ts`        | Extended with `primaryBackend`, `fallbackBackends`, `backendConfigs` + normalization |
| `src/shared/schemas/memory.ts`      | Added backend fields to `MemorySettingsExtendedSchema`                               |

### Settings Schema (DB + API)

```json
{
  "memoryEnabled": true,
  "primaryBackend": "sqlite",
  "fallbackBackends": ["obsidian"],
  "backendConfigs": {
    "obsidian": {
      "baseUrl": "http://localhost:27123",
      "apiKey": "...",
      "endpoints": {
        "search": "/api/v1/vault/memories/search",
        "create": "/api/v1/vault/memories",
        "get": "/api/v1/vault/memories/{memoryId}"
      },
      "queryParams": { "query": "q", "apiKeyId": "api_key" },
      "pathParams": { "id": "memoryId" }
    }
  }
}
```

### GenericMemoryBackend — Dynamic Endpoint Mapping

```typescript
// Any REST backend becomes pluggable via config
createGenericMemoryBackend("obsidian", "Obsidian Vault", {
  baseUrl: "http://localhost:27123",
  apiKey: process.env.OBSIDIAN_API_KEY,
  endpoints: {
    search: "/api/v1/vault/memories/search",
    create: "/api/v1/vault/memories",
    get: "/api/v1/vault/memories/{memoryId}",
  },
  queryParams: { query: "q", apiKeyId: "api_key" },
  pathParams: { id: "memoryId" },
});
```

**Supported mappings:**

- `endpoints` — override any REST path (supports `{id}`, `{memoryId}` placeholders)
- `queryParams` — rename any query parameter (`query` → `q`, `apiKeyId` → `api_key`, etc.)
- `pathParams` — rename path placeholders (`id` → `memoryId`)

### Connecting Global `omniroute` to Custom Memory Backend

```bash
# Via environment variables (auto-registers on startup)
export OBSIDIAN_API_URL=http://localhost:27123
export OBSIDIAN_API_KEY=your-key
omniroute start

# Or via Settings API after startup (persists to DB)
curl -X PUT /api/settings/memory -d '{ "primaryBackend": "obsidian", ... }'
```

### Verification

- ✅ Typecheck: `tsc --noEmit` — clean
- ✅ Memory tests: 45 passed, 6 skipped (pre-existing FTS5 test infra issue)
- ✅ Skills integration tests: 8 passed
- ✅ Behavioral parity: `store.ts`/`retrieval.ts` identical to v3.8.49 (newline-only diff)

## Migration Notes

- **Zero behavior change** for existing SQLite memory — `store.ts`/`retrieval.ts` unchanged
- New settings are additive with safe defaults (`primaryBackend: "sqlite"`, `fallbackBackends: []`)
- Existing callers (`chatCore.ts`, dashboard, CLI) work unchanged — they route through `memoryManager`

## Future Work (Not in this PR)

- Dashboard UI for backend selector + config forms (Phase 5)
- Auto-discovery of npm plugins (`omniroute-memory-backend-*`)
- Response transformers for non-standard backend shapes
