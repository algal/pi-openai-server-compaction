import assert from "node:assert/strict";
import extensionFactory from "../src/index.ts";
import { isAzureOpenAIResponsesModel, supportsRemoteCompactionModel } from "../src/openai.ts";
import {
  azureCompactionEndpointUrl,
  buildRemoteCompactionDetails,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionRequestBody,
  callRemoteCompactionEndpoint,
  reconstructRemoteCompactionStateFromBranch,
} from "../src/remote-compaction.ts";

export async function runAzureTests() {
  const model: any = {
    provider: "openai", api: "openai-responses", id: "azure-deployment",
    baseUrl: "https://test.services.ai.azure.com/openai/v1/",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const host of ["test.services.ai.azure.com", "test.openai.azure.com"]) {
    const azure = { ...model, baseUrl: `https://${host}/openai/v1/` };
    assert.equal(isAzureOpenAIResponsesModel(azure), true);
    assert.equal(supportsRemoteCompactionModel(azure), false, "Azure remains opt-in");
    assert.equal(supportsRemoteCompactionModel(azure, { includeAzure: true }), true);
    assert.equal(azureCompactionEndpointUrl(azure), `https://${host}/openai/v1/responses/compact`);
    assert.equal(azureCompactionEndpointUrl({ ...azure, baseUrl: `https://${host}` }),
      `https://${host}/openai/v1/responses/compact`);
    for (const path of ["/openai", "/openai/v1/responses", "/openai/v1/responses/compact/"]) {
      assert.equal(azureCompactionEndpointUrl({ ...azure, baseUrl: `https://${host}${path}?api-version=v1` }),
        `https://${host}/openai/v1/responses/compact?api-version=v1`);
    }
  }
  for (const api of ["openai-responses", "azure-openai-responses"]) {
    for (const provider of ["azure-openai", "azure-openai-responses"]) {
      assert.equal(supportsRemoteCompactionModel({ ...model, api, provider }, { includeAzure: true }), true);
    }
  }
  for (const host of ["services.ai.azure.com.evil.test", "openai.azure.com.evil.test", "models.example.com"]) {
    assert.equal(isAzureOpenAIResponsesModel({ ...model, baseUrl: `https://${host}/openai/v1` }), false);
  }
  assert.equal(supportsRemoteCompactionModel({ ...model, api: "anthropic-messages" }, { includeAzure: true }), false);
  assert.throws(() => azureCompactionEndpointUrl({ ...model, baseUrl: undefined }), /explicit/);
  assert.throws(() => azureCompactionEndpointUrl({ ...model, baseUrl: "https://test.openai.azure.com/openai/deployments/test" }), /v1/);

  const input: any[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Remember blue-42" }] }];
  const output: any[] = [
    ...input,
    { type: "reasoning", encrypted_content: "OPAQUE_REASONING", summary: [] },
    { id: "cmp_1", type: "compaction", encrypted_content: "OPAQUE", provider_field: "preserve" },
  ];
  const params = {
    model, input, apiKey: "test-key", headers: { "Api-Key": "configured-key", "x-extra": "keep" },
    instructions: "system instructions", tools: [{ type: "function", name: "read" }],
    parallelToolCalls: true, reasoning: { effort: "high" as const }, text: { verbosity: "medium" },
  };
  assert.deepEqual(buildRemoteCompactionRequestBody(params), {
    model: model.id, input, instructions: params.instructions,
  });
  const headers = buildRemoteCompactionHeaders(params);
  assert.equal(headers["api-key"], "configured-key");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-codex-beta-features"], undefined);
  assert.equal(headers["x-codex-installation-id"], undefined);
  assert.equal(headers["x-extra"], "keep");
  assert.equal(buildRemoteCompactionHeaders({ model, apiKey: "default-key" })["api-key"], "default-key");
  const bearer = buildRemoteCompactionHeaders({ model, apiKey: "token", headers: { Authorization: "Bearer configured" } });
  assert.equal(bearer.authorization, "Bearer configured");
  assert.equal(bearer["api-key"], undefined);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://test.services.ai.azure.com/openai/v1/responses/compact");
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(String(options?.body)), { model: model.id, input, instructions: params.instructions });
      assert.equal(new Headers(options?.headers).get("api-key"), "configured-key");
      return Response.json({ output, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
    };
    const result = await callRemoteCompactionEndpoint(params);
    assert.deepEqual(result.output, output, "the returned window is kept intact");
    assert.equal(result.usage?.totalTokens, 15);
    const details = buildRemoteCompactionDetails(model, result.output, result.usage);
    assert.equal(details.implementation, "responses_compact_v1");
    const entries: any[] = [{ type: "compaction", id: "cmp-entry", details: { remoteCompaction: details } }];
    assert.deepEqual(reconstructRemoteCompactionStateFromBranch({ branchEntries: entries })?.explicitHistory, output);

    const hooks = new Map<string, any>();
    extensionFactory({ on: (name: string, fn: any) => hooks.set(name, fn), registerProvider() {} } as any);
    const ctx: any = { cwd: "/tmp", model, hasUI: false,
      sessionManager: { getSessionId: () => "azure-smoke", getBranch: () => entries } };
    const savedAzure = process.env.PI_OPENAI_SERVER_COMPACTION_AZURE;
    const savedEnabled = process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
    process.env.PI_OPENAI_SERVER_COMPACTION_AZURE = "1";
    process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "1";
    try {
      hooks.get("session_start")({}, ctx);
      const message = { role: "user", content: [{ type: "text", text: "NEW_PROMPT" }] };
      hooks.get("message_end")({ message }, ctx);
      const instructions = { role: "developer", content: "CURRENT_SYSTEM_PROMPT" };
      const payload = hooks.get("before_provider_request")({ payload: {
        model: model.id, input: [instructions, "Pi text summary"], previous_response_id: "stale", store: false,
        tools: params.tools,
      } }, ctx);
      assert.deepEqual(payload.input, [instructions, ...output, { type: "message", role: "user", content: [{ type: "input_text", text: "NEW_PROMPT" }] }]);
      assert.deepEqual(payload.tools, params.tools);
      assert.equal(payload.previous_response_id, undefined);
      assert.equal(payload.store, false);
      assert.equal(payload.context_management, undefined);
      process.env.PI_OPENAI_SERVER_COMPACTION_AZURE = "0";
      assert.equal(hooks.get("before_provider_request")({ payload: { model: model.id, input: [] } }, ctx), undefined);
      assert.equal(await hooks.get("session_before_compact")({}, ctx), undefined);
    } finally {
      hooks.get("session_shutdown")();
      if (savedAzure === undefined) delete process.env.PI_OPENAI_SERVER_COMPACTION_AZURE;
      else process.env.PI_OPENAI_SERVER_COMPACTION_AZURE = savedAzure;
      if (savedEnabled === undefined) delete process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
      else process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = savedEnabled;
    }

    globalThis.fetch = async () => Response.json({ error: { message: "not supported" } }, { status: 400 });
    await assert.rejects(callRemoteCompactionEndpoint(params), /400.*not supported/);
    globalThis.fetch = async () => Response.json({ output: [{ type: "message", role: "user", content: [] }] });
    await assert.rejects(callRemoteCompactionEndpoint(params), /compacted output window/);
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (_url, options) => {
      options?.signal?.throwIfAborted();
      throw new Error("expected an aborted signal");
    };
    await assert.rejects(callRemoteCompactionEndpoint({ ...params, signal: controller.signal }), { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
