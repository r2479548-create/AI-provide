import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limit-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const providers = await import("../../src/lib/db/providers.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");

const TARGET = "openai/gpt-5.6";
const LIMITS = { context: 372000, input: 353400, output: 128000 };

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  catalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function getModel(target = TARGET) {
  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  return body.data.find((model) => model.id === target);
}

test("v1 model catalog projects effective context, input, and output overrides and invalidates on delete", async () => {
  assert.equal(contextOverrides.setModelContextOverride("openai", "gpt-5.6", LIMITS.context), true);
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_input_tokens", LIMITS.input),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_output_tokens", LIMITS.output),
    true
  );
  await providers.createProviderConnection({
    provider: "openai",
    authType: "api_key",
    name: "token-limit-catalog",
    apiKey: "sk-test",
  });

  const initial = await getModel();
  assert.ok(initial);
  assert.deepEqual(
    {
      context_length: initial.context_length,
      max_input_tokens: initial.max_input_tokens,
      max_output_tokens: initial.max_output_tokens,
    },
    {
      context_length: LIMITS.context,
      max_input_tokens: LIMITS.input,
      max_output_tokens: LIMITS.output,
    }
  );

  const sentinelOutput = 111111;
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_output_tokens", sentinelOutput),
    true
  );
  assert.equal((await getModel())?.max_output_tokens, sentinelOutput);
  assert.equal(
    capabilityOverrides.removeModelCapabilityOverride(TARGET, "max_output_tokens"),
    true
  );
  assert.notEqual((await getModel())?.max_output_tokens, sentinelOutput);
});

test("v1 model catalog projects an exact raw-alias context override", async () => {
  const target = "github/claude-opus-4.5";
  assert.equal(contextOverrides.setModelContextOverride("github", "claude-opus-4.5", 333333), true);
  await providers.createProviderConnection({
    provider: "github",
    authType: "api_key",
    name: "raw-alias-token-limit-catalog",
    apiKey: "ghp-test",
  });

  assert.equal(
    (await getModel(target))?.context_length,
    333333,
    "the catalog entry keeps its raw alias and must project that exact override"
  );
});
