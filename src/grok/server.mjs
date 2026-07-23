import http from "node:http";

import {
  approximateTokens,
  chooseSafeCutIndex,
  identityHash,
  sourcePrefixHash,
  StateStore,
} from "./core.mjs";

const HOP_HEADERS = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
function headerMap(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]).filter(([, value]) => typeof value === "string"));
}

function forwardedHeaders(headers, bodyLength) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) output[key] = value;
  }
  if (bodyLength !== undefined) output["content-length"] = String(bodyLength);
  return output;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body exceeds 64 MiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

function normalizeGptResponsesBody(body) {
  if (!body || typeof body !== "object" || !String(body.model || "").startsWith("gpt-")) return body;
  const normalized = { ...body };
  // ChatGPT/Codex reasoning models reject sampling controls that official Grok emits.
  delete normalized.temperature;
  delete normalized.top_p;
  if (Array.isArray(normalized.input)) {
    const instructionParts = [];
    normalized.input = normalized.input.filter((item) => {
      if (!item || typeof item !== "object" || !["system", "developer"].includes(item.role)) return true;
      const text = messageText(item.content);
      if (text) instructionParts.push(text);
      return false;
    });
    if (instructionParts.length > 0) {
      normalized.instructions = [normalized.instructions, ...instructionParts].filter((value) => typeof value === "string" && value).join("\n\n");
    }
  }
  return normalized;
}

function helperRewrite(body, headers, helperModel) {
  if (headers["x-grok-session-id"] || !body || typeof body !== "object") return normalizeGptResponsesBody(body);
  if (!["grok-4.5", "grok-build"].includes(body.model)) return normalizeGptResponsesBody(body);
  return normalizeGptResponsesBody({ ...body, model: helperModel });
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function safeErrorMessage(buffer) {
  try {
    const parsed = JSON.parse(Buffer.concat(buffer).toString("utf8"));
    const message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message;
    return typeof message === "string" ? message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function responseTransformer() {
  let buffer = "";
  let completed = false;
  let terminalFailure = false;
  const outputItems = [];

  function transformBlock(block) {
    const event = parseSseBlock(block);
    if (!event) return `${block}\n\n`;
    // Official Grok's Responses parser rejects Codex extension events.
    if (["keepalive", "response.metadata"].includes(event.type)) return "";
    if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      outputItems.push(event.item);
    }
    if (["response.completed", "response.incomplete"].includes(event.type) && event.response && typeof event.response === "object") {
      if (!Array.isArray(event.response.output) || event.response.output.length === 0) event.response.output = outputItems;
    }
    if (event.type === "response.completed" && event.response?.status === "completed") completed = true;
    if (["response.failed", "response.incomplete"].includes(event.type)) terminalFailure = true;
    const eventName = block.split(/\r?\n/).find((line) => line.startsWith("event:"));
    return `${eventName ? `${eventName}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
  }

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      const output = [];
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const transformed = transformBlock(block);
        if (transformed) output.push(Buffer.from(transformed));
      }
      return output;
    },
    flush() {
      if (!buffer) return [];
      const transformed = transformBlock(buffer);
      buffer = "";
      return transformed ? [Buffer.from(transformed)] : [];
    },
    isSuccessful() {
      return completed && !terminalFailure;
    },
  };
}

function createKeyLocks() {
  const locks = new Map();
  return async (key, operation) => {
    const prior = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => gate);
    locks.set(key, tail);
    await prior.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  };
}

export function resolveUpstreamUrl(baseUrl, requestUrl) {
  const target = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const incoming = new URL(requestUrl, "http://grok-gateway.local");
  const basePath = target.pathname.replace(/\/+$/, "");
  let suffix = incoming.pathname;
  if (basePath.endsWith("/v1") && suffix.startsWith("/v1/")) suffix = suffix.slice(3);
  target.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, "/");
  target.search = incoming.search;
  return target;
}

function createHttpUpstream(baseUrl) {
  return {
    label: baseUrl,
    async open({ path, method = "POST", headers, body, signal }) {
      const target = resolveUpstreamUrl(baseUrl, path);
      return fetch(target, {
        method,
        headers: forwardedHeaders({ ...headers, "accept-encoding": "identity" }, body?.length),
        body,
        signal,
      });
    },
    async requestJson(options) {
      const response = await this.open(options);
      const raw = await response.text();
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      return JSON.parse(raw);
    },
  };
}

async function requestCompaction({ upstreamClient, path, headers, body, signal, logger, key }) {
  const payload = {
    ...body,
    input: [...body.input, { type: "compaction_trigger" }],
    stream: false,
    store: false,
    tool_choice: "auto",
  };
  delete payload.previous_response_id;
  try {
    const parsed = await upstreamClient.requestJson({
      path,
      method: "POST",
      headers: forwardedHeaders({ ...headers, "content-type": "application/json" }),
      body: Buffer.from(JSON.stringify(payload)),
      signal,
    });
    const items = Array.isArray(parsed?.output) ? parsed.output.filter((item) => item?.type === "compaction") : [];
    if (items.length !== 1 || typeof items[0].encrypted_content !== "string") throw new Error(`expected one opaque compaction item, got ${items.length}`);
    logger("compaction_ready", { key: key?.slice(0, 12), bytes: Buffer.byteLength(JSON.stringify(items[0])) });
    return structuredClone(items[0]);
  } catch (error) {
    logger("compaction_failed_open", { key: key?.slice(0, 12), error: error?.message || String(error) });
    return null;
  }
}

async function proxyRequest({ upstreamClient, request, response, rawBody, body, candidate, store, key, logger }) {
  const tracker = responseTransformer();
  const controller = new AbortController();
  let clientClosed = false;
  response.on("close", () => {
    if (!response.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });
  request.on("aborted", () => {
    clientClosed = true;
    controller.abort();
  });
  const encoded = body === undefined ? rawBody : Buffer.from(JSON.stringify(body));
  const requestHeaders = forwardedHeaders(request.headers, encoded.length);
  requestHeaders["accept-encoding"] = "identity";
  try {
    const upstreamResponse = await upstreamClient.open({
      path: request.url,
      method: request.method,
      headers: requestHeaders,
      body: encoded,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
    });
    const errorChunks = [];
    let errorBytes = 0;
    const status = upstreamResponse.status;
    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
    const isSse = String(responseHeaders["content-type"] || "").includes("text/event-stream");
    response.writeHead(status, forwardedHeaders(responseHeaders));
    if (upstreamResponse.body) {
      for await (const value of upstreamResponse.body) {
        const chunk = Buffer.from(value);
        const outbound = isSse ? tracker.push(chunk) : [chunk];
        if (status >= 400 && errorBytes < 4096) {
          const retained = chunk.subarray(0, Math.max(0, 4096 - errorBytes));
          errorChunks.push(retained);
          errorBytes += retained.length;
        }
        if (!clientClosed) for (const part of outbound) response.write(part);
      }
    }
    if (isSse && !clientClosed) for (const part of tracker.flush()) response.write(part);
    if (status >= 400) logger("upstream_http_error", { status, error: safeErrorMessage(errorChunks) });
    const success = status < 300 && tracker.isSuccessful() && !clientClosed;
    logger("upstream_response", { status, completed: tracker.isSuccessful(), clientClosed });
    if (candidate && success) {
      try {
        await store.commit(key, candidate);
        logger("compaction_committed", { key: key.slice(0, 12), prefixItems: candidate.sourcePrefixLength });
      } catch (error) {
        logger("state_commit_failed", { key: key.slice(0, 12), error: error?.message || String(error) });
      }
    }
    if (!clientClosed) response.end();
  } catch (error) {
    logger("upstream_request_error", { error: error?.message || String(error) });
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    if (!clientClosed) response.end(JSON.stringify({ error: { message: "gateway upstream unavailable", type: "gateway_error" } }));
  }
}

export function createGateway(options) {
  const {
    host = "127.0.0.1",
    port = 10532,
    upstream = "http://127.0.0.1:10531",
    stateFile,
    thresholdTokens = 180_000,
    keepTokens = 20_000,
    helperModel = "gpt-5.6-luna",
    logger = () => {},
  } = options;
  if (!stateFile) throw new Error("stateFile is required");
  const store = new StateStore(stateFile, logger);
  const upstreamClient = createHttpUpstream(upstream);
  const withKeyLock = createKeyLocks();
  let server;

  async function handle(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      await store.load();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, version: 1, upstream: upstreamClient.label, branches: store.countBranches() }));
      return;
    }
    let rawBody;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      response.writeHead(error.statusCode || 400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message, type: "gateway_error" } }));
      return;
    }
    const headers = headerMap(request.headers);
    let parsed;
    if (request.method === "POST" && request.url?.replace(/\/$/, "") === "/v1/responses") {
      try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { parsed = undefined; }
    }
    const originalModel = parsed?.model;
    parsed = helperRewrite(parsed, headers, helperModel);
    if (parsed) logger("grok_request", {
      model: parsed.model,
      helperRewritten: originalModel !== parsed.model,
      session: Boolean(headers["x-grok-session-id"]),
      inputItems: Array.isArray(parsed.input) ? parsed.input.length : undefined,
      toolChoice: typeof parsed.tool_choice === "object" ? parsed.tool_choice?.name || parsed.tool_choice?.type : parsed.tool_choice,
    });
    const key = parsed ? identityHash(headers, parsed.model, {
      instructions: parsed.instructions,
      tools: parsed.tools,
      reasoning: parsed.reasoning,
      text: parsed.text,
    }) : null;

    const operation = async () => {
      let mainBody = parsed;
      let candidate = null;
      const input = Array.isArray(parsed?.input) ? parsed.input : null;
      const isExplicitCompaction = input?.some((item) => item?.type === "compaction_trigger");
      if (key && input && !isExplicitCompaction) {
        const branch = await store.match(key, input);
        const baseLength = branch?.sourcePrefixLength || 0;
        const replacement = branch?.replacement || [];
        const effectiveInput = branch ? [...replacement, ...input.slice(baseLength)] : input;
        mainBody = { ...parsed, input: effectiveInput };
        const tokens = approximateTokens(effectiveInput);
        if (tokens > thresholdTokens) {
          const cut = chooseSafeCutIndex(input, tokens, keepTokens, baseLength);
          if (cut > baseLength) {
            const compactable = [...replacement, ...input.slice(baseLength, cut)];
            const item = await requestCompaction({
              upstreamClient,
              path: request.url,
              headers: request.headers,
              body: { ...parsed, input: compactable },
              signal: AbortSignal.timeout(300_000),
              logger,
              key,
            });
            if (item) {
              candidate = {
                sourcePrefixLength: cut,
                sourcePrefixHash: sourcePrefixHash(input, cut),
                replacement: [item],
                createdAt: new Date().toISOString(),
              };
              mainBody = { ...parsed, input: [item, ...input.slice(cut)] };
            }
          }
        }
      }
      await proxyRequest({ upstreamClient, request, response, rawBody, body: mainBody, candidate, store, key, logger });
    };

    if (key) await withKeyLock(key, operation);
    else await operation();
  }

  return {
    get url() {
      const address = server?.address();
      return address && typeof address === "object" ? `http://${host}:${address.port}` : null;
    },
    async start() {
      if (server) return;
      server = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
          logger("request_handler_failed", { error: error?.message || String(error) });
          if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
          if (!response.writableEnded) response.end(JSON.stringify({ error: { message: "gateway internal error", type: "gateway_error" } }));
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      logger("gateway_started", { host, port: server.address().port, upstream: upstreamClient.label });
    },
    async close() {
      if (!server) return;
      const closing = server;
      server = undefined;
      const stopped = new Promise((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
      closing.closeAllConnections?.();
      await stopped;
    },
  };
}
