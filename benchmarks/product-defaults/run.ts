#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  convertToLlm,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { DEFAULT_THINKING_LEVEL } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/defaults.js";
import { thinkingLevelToResponsesReasoning } from "../../src/openai.ts";
import {
  callRemoteCompactionEndpoint,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  type ResponseItem,
} from "../../src/remote-compaction.ts";
import {
  buildProductFixtures,
  type BenchmarkQuestion,
  type ProductFixture,
} from "./fixtures.ts";

const API_URL = "https://api.openai.com/v1/responses";
const SYSTEM_INSTRUCTIONS =
  "You are the assistant responsible for one synthetic software project. " +
  "Treat statements marked authoritative as binding, preserve exact identifiers and tool outputs, " +
  "apply final corrections over superseded values, and maintain exact task checkpoints.";

type Arm = "full_context" | "pi_default" | "native_extension";

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_write_tokens?: number;
  };
};

type ResponsesBody = {
  id?: string;
  status?: string;
  incomplete_details?: unknown;
  output?: Array<Record<string, unknown>>;
  usage?: RawUsage;
  error?: { message?: string };
};

type ScoreRow = {
  questionId: string;
  category: string;
  epoch: number;
  expected: string;
  actual: string;
  correct: boolean;
};

type EvaluationRecord = {
  latencyMs: number;
  usage?: Usage;
  responseId?: string;
  status?: string;
  incompleteDetails?: unknown;
  rawText: string;
  parsedAnswers: Record<string, string>;
  scores: ScoreRow[];
};

export type ProductTrialRecord = {
  fixtureId: string;
  seed: number;
  density: number;
  targetTokens: number;
  estimatedTokens: number;
  authoritativeRecords: number;
  questionCount: number;
  compactionOrder:
    | readonly ["pi_default", "native_extension"]
    | readonly ["native_extension", "pi_default"];
  piDefault: {
    latencyMs: number;
    usage?: Usage;
    stopReason?: string;
    errorMessage?: string;
    summary: string;
    summaryCharacters: number;
    configuredMaxOutputTokens: number;
    firstKeptEntryId: string;
    summarizedMessageCount: number;
    retainedMessageCount: number;
    downstreamContextItems: number;
  };
  nativeExtension: {
    latencyMs: number;
    usage?: Usage;
    artifactSha256: string;
    artifactBytes: number;
    retainedUserMessageItems: number;
    downstreamContextItems: number;
  };
  evaluations: Record<Arm, EvaluationRecord>;
  recordedCostUsd: number;
};

type RunOptions = {
  modelId: string;
  seeds: number[];
  densities: number[];
  targetTokens: number;
  questionsPerCategory: number;
  maxCostUsd: number;
  outputDir?: string;
  outputRoot: string;
  label: string;
};

function parseIntegerList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value.split(",").map((part) => Number(part.trim()));
  if (parsed.length === 0 || parsed.some((number) => !Number.isInteger(number) || number < 1)) {
    throw new Error(`Invalid positive-integer list: ${value}`);
  }
  return [...new Set(parsed)];
}

function parseArgs(argv: string[]): RunOptions {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const modelId = read("--model") ?? "gpt-5.6-sol";
  const seeds = parseIntegerList(read("--seeds"), [1]);
  const densities = parseIntegerList(read("--densities"), [120]);
  const targetTokens = Number(read("--target-tokens") ?? "50000");
  const questionsPerCategory = Number(read("--questions-per-category") ?? "15");
  const maxCostUsd = Number(read("--max-cost-usd") ?? "8");
  const outputDir = read("--output-dir");
  const outputRoot = resolve(read("--output-root") ?? join("benchmarks", "product-defaults", "results"));
  const label = read("--label") ?? "product-defaults";
  if (!Number.isInteger(targetTokens) || targetTokens < 25_000) {
    throw new Error("--target-tokens must be an integer of at least 25000");
  }
  if (!Number.isInteger(questionsPerCategory) || questionsPerCategory < 1) {
    throw new Error("--questions-per-category must be a positive integer");
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error("--max-cost-usd must be positive");
  }
  return {
    modelId,
    seeds,
    densities,
    targetTokens,
    questionsPerCategory,
    maxCostUsd,
    outputDir,
    outputRoot,
    label,
  };
}

function normalizeAnswer(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/^['"]|['"]$/g, "")
    : String(value ?? "").trim();
}

function usageFromRaw(model: Model<Api>, raw: RawUsage | undefined): Usage | undefined {
  if (!raw) return undefined;
  const cacheRead = raw.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite =
    raw.input_tokens_details?.cache_creation_tokens ??
    raw.input_tokens_details?.cache_write_tokens ??
    0;
  const inputTokens = raw.input_tokens ?? 0;
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: raw.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
    totalTokens: raw.total_tokens ?? inputTokens + (raw.output_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function outputText(body: ResponsesBody): string {
  return (body.output ?? [])
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

async function requestResponse(
  apiKey: string,
  body: Record<string, unknown>,
  attempts = 4,
): Promise<{ body: ResponsesBody; latencyMs: number }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = Date.now();
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as ResponsesBody) : {};
      if (!response.ok) {
        throw new Error(`Responses API ${response.status}: ${parsed.error?.message ?? text.slice(0, 500)}`);
      }
      return { body: parsed, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt + 1 < attempts) await delay(1000 * 2 ** attempt);
    }
  }
  throw lastError ?? new Error("Responses request failed");
}

function evaluationMessage(questions: BenchmarkQuestion[]): ResponseItem {
  const rendered = questions.map((question) => `${question.id}: ${question.question}`).join("\n");
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text:
        "Answer every benchmark question from the supplied project history. " +
        "Return only the JSON object required by the response schema. Each value must be the exact canonical value, " +
        "with no explanation, labels, units, or extra punctuation.\n\n" +
        rendered,
    }],
  };
}

function answerSchema(questions: BenchmarkQuestion[]): Record<string, unknown> {
  const properties = Object.fromEntries(questions.map((question) => [question.id, { type: "string" }]));
  return {
    type: "json_schema",
    name: "product_compaction_answers",
    strict: true,
    schema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          properties,
          required: questions.map((question) => question.id),
          additionalProperties: false,
        },
      },
      required: ["answers"],
      additionalProperties: false,
    },
  };
}

function parseAnswers(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as { answers?: unknown };
    if (!parsed.answers || typeof parsed.answers !== "object" || Array.isArray(parsed.answers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.answers as Record<string, unknown>)
        .map(([key, value]) => [key, normalizeAnswer(value)]),
    );
  } catch {
    return {};
  }
}

function scoreAnswers(
  questions: BenchmarkQuestion[],
  answers: Record<string, string>,
): ScoreRow[] {
  return questions.map((question) => {
    const actual = normalizeAnswer(answers[question.id]);
    const expected = normalizeAnswer(question.expected);
    return {
      questionId: question.id,
      category: question.category,
      epoch: question.epoch,
      expected,
      actual,
      correct: actual === expected,
    };
  });
}

async function evaluateArm(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: ProductFixture;
  context: ResponseItem[];
}): Promise<EvaluationRecord> {
  const response = await requestResponse(params.apiKey, {
    model: params.model.id,
    instructions: SYSTEM_INSTRUCTIONS,
    input: [...params.context, evaluationMessage(params.fixture.questions)],
    tools: params.fixture.tools,
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: null },
    text: { format: answerSchema(params.fixture.questions) },
    max_output_tokens: 8192,
    store: false,
  });
  const text = outputText(response.body);
  const answers = parseAnswers(text);
  return {
    latencyMs: response.latencyMs,
    usage: usageFromRaw(params.model, response.body.usage),
    responseId: response.body.id,
    status: response.body.status,
    incompleteDetails: response.body.incomplete_details,
    rawText: text,
    parsedAnswers: answers,
    scores: scoreAnswers(params.fixture.questions, answers),
  };
}

function messagesToEntries(fixture: ProductFixture): SessionEntry[] {
  let parentId: string | null = null;
  return fixture.messages.map((message, index) => {
    const id = `${fixture.id}-entry-${String(index + 1).padStart(5, "0")}`;
    const entry: SessionEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    };
    parentId = id;
    return entry;
  });
}

function messagesAsResponseItems(
  messages: AgentMessage[],
  model: Model<Api>,
): ResponseItem[] {
  const llmMessages = convertToLlm(messages);
  return normalizeResponseItemsForPrompt(
    messagesToResponseItems(llmMessages as AgentMessage[]),
    model,
  );
}

async function compactPiDefault(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: ProductFixture;
}): Promise<{
  context: ResponseItem[];
  record: ProductTrialRecord["piDefault"];
}> {
  const entries = messagesToEntries(params.fixture);
  const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
  if (!preparation) throw new Error(`Pi could not prepare ${params.fixture.id} for compaction`);

  let capturedPromise: Promise<AssistantMessage> | undefined;
  const captureStream: StreamFn = (model, context, options) => {
    const stream = streamSimple(model, context, options);
    capturedPromise = stream.result();
    return stream;
  };

  const started = Date.now();
  const result = await compact(
    preparation,
    params.model,
    params.apiKey,
    undefined,
    undefined,
    undefined,
    DEFAULT_THINKING_LEVEL,
    captureStream,
  );
  const captured = capturedPromise ? await capturedPromise : undefined;
  if (!captured) throw new Error(`Pi compaction returned no captured model response for ${params.fixture.id}`);

  const parentId = entries.at(-1)?.id ?? null;
  const compactionEntry: CompactionEntry = {
    type: "compaction",
    id: `${params.fixture.id}-compaction`,
    parentId,
    timestamp: new Date((params.fixture.messages.at(-1)?.timestamp ?? Date.now()) + 1).toISOString(),
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
  };
  const postCompactionMessages = buildSessionContext([...entries, compactionEntry]).messages;
  const firstKeptIndex = entries.findIndex((entry) => entry.id === result.firstKeptEntryId);

  return {
    context: messagesAsResponseItems(postCompactionMessages, params.model),
    record: {
      latencyMs: Date.now() - started,
      usage: captured.usage,
      stopReason: captured.stopReason,
      errorMessage: captured.errorMessage,
      summary: result.summary,
      summaryCharacters: result.summary.length,
      configuredMaxOutputTokens: Math.min(
        Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens),
        params.model.maxTokens > 0 ? params.model.maxTokens : Number.POSITIVE_INFINITY,
      ),
      firstKeptEntryId: result.firstKeptEntryId,
      summarizedMessageCount: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
      retainedMessageCount: firstKeptIndex < 0 ? 0 : entries.length - firstKeptIndex,
      downstreamContextItems: messagesAsResponseItems(postCompactionMessages, params.model).length,
    },
  };
}

async function compactNativeExtension(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: ProductFixture;
}): Promise<{
  context: ResponseItem[];
  record: ProductTrialRecord["nativeExtension"];
}> {
  const input = messagesAsResponseItems(params.fixture.messages, params.model);
  const started = Date.now();
  const result = await callRemoteCompactionEndpoint({
    model: params.model,
    apiKey: params.apiKey,
    sessionId: randomUUID(),
    input,
    instructions: SYSTEM_INSTRUCTIONS,
    tools: params.fixture.tools,
    parallelToolCalls: true,
    reasoning: thinkingLevelToResponsesReasoning(DEFAULT_THINKING_LEVEL),
  });
  const compactionItem = [...result.output].reverse().find((item) => item.type === "compaction");
  const encryptedContent = compactionItem && "encrypted_content" in compactionItem
    ? compactionItem.encrypted_content
    : undefined;
  if (typeof encryptedContent !== "string") {
    throw new Error(`Native extension returned no compaction artifact for ${params.fixture.id}`);
  }
  const context = normalizeResponseItemsForPrompt(result.output, params.model);
  return {
    context,
    record: {
      latencyMs: Date.now() - started,
      usage: result.usage,
      artifactSha256: createHash("sha256").update(encryptedContent).digest("hex"),
      artifactBytes: Buffer.byteLength(encryptedContent, "utf8"),
      retainedUserMessageItems: result.output.filter(
        (item) => item.type === "message" && item.role === "user",
      ).length,
      downstreamContextItems: context.length,
    },
  };
}

function totalRecordCost(record: Omit<ProductTrialRecord, "recordedCostUsd">): number {
  return (
    (record.piDefault.usage?.cost.total ?? 0) +
    (record.nativeExtension.usage?.cost.total ?? 0) +
    Object.values(record.evaluations).reduce(
      (total, evaluation) => total + (evaluation.usage?.cost.total ?? 0),
      0,
    )
  );
}

async function runTrial(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: ProductFixture;
}): Promise<ProductTrialRecord> {
  const piFirst = (params.fixture.seed + params.fixture.density) % 2 === 0;
  const compactionOrder = piFirst
    ? ["pi_default", "native_extension"] as const
    : ["native_extension", "pi_default"] as const;

  let pi: Awaited<ReturnType<typeof compactPiDefault>>;
  let native: Awaited<ReturnType<typeof compactNativeExtension>>;
  if (piFirst) {
    pi = await compactPiDefault(params);
    await delay(300);
    native = await compactNativeExtension(params);
  } else {
    native = await compactNativeExtension(params);
    await delay(300);
    pi = await compactPiDefault(params);
  }

  const tail = messagesAsResponseItems(params.fixture.sharedTail, params.model);
  const contexts: Record<Arm, ResponseItem[]> = {
    full_context: [...messagesAsResponseItems(params.fixture.messages, params.model), ...tail],
    pi_default: [...pi.context, ...tail],
    native_extension: [...native.context, ...tail],
  };
  const rotations: Arm[][] = [
    ["full_context", "pi_default", "native_extension"],
    ["pi_default", "native_extension", "full_context"],
    ["native_extension", "full_context", "pi_default"],
  ];
  const evaluationOrder = rotations[(params.fixture.seed + params.fixture.density) % rotations.length]!;
  const evaluations = {} as Record<Arm, EvaluationRecord>;
  for (const arm of evaluationOrder) {
    evaluations[arm] = await evaluateArm({
      apiKey: params.apiKey,
      model: params.model,
      fixture: params.fixture,
      context: contexts[arm],
    });
    await delay(300);
  }

  const withoutCost = {
    fixtureId: params.fixture.id,
    seed: params.fixture.seed,
    density: params.fixture.density,
    targetTokens: params.fixture.targetTokens,
    estimatedTokens: params.fixture.estimatedTokens,
    authoritativeRecords: params.fixture.authoritativeRecords,
    questionCount: params.fixture.questions.length,
    compactionOrder,
    piDefault: pi.record,
    nativeExtension: native.record,
    evaluations,
  };
  return {
    ...withoutCost,
    recordedCostUsd: totalRecordCost(withoutCost),
  };
}

async function readExistingRecords(path: string): Promise<ProductTrialRecord[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProductTrialRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function runDirectory(options: RunOptions): string {
  if (options.outputDir) return resolve(options.outputDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = options.label.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return join(options.outputRoot, `${timestamp}_${safeLabel}_${options.modelId}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = getModel("openai", options.modelId as Parameters<typeof getModel>[1]);
  if (!model) throw new Error(`Model not found: openai/${options.modelId}`);

  const fixtures = buildProductFixtures(
    options.seeds,
    options.densities,
    options.targetTokens,
    options.questionsPerCategory,
  );
  const directory = runDirectory(options);
  await mkdir(directory, { recursive: true });
  const recordsPath = join(directory, "trials.jsonl");
  const existing = await readExistingRecords(recordsPath);
  const completed = new Set(existing.map((record) => record.fixtureId));
  let recordedCostUsd = existing.reduce((total, record) => total + record.recordedCostUsd, 0);

  const manifest = {
    benchmark: "pi-default-vs-extension-native-product-policies",
    label: options.label,
    createdAt: new Date().toISOString(),
    model: `openai/${model.id}`,
    seeds: options.seeds,
    densities: options.densities,
    targetTokens: options.targetTokens,
    questionsPerCategory: options.questionsPerCategory,
    piSettings: DEFAULT_COMPACTION_SETTINGS,
    defaultThinkingLevel: DEFAULT_THINKING_LEVEL,
    nativeProtocol: "Responses compaction v2 through extension callRemoteCompactionEndpoint",
    nativeRequestTuning:
      "default Pi request shape: reasoning medium/auto; no explicit text configuration",
    primaryBudgetRule: "none; each product policy uses its own default output behavior",
    maxCostUsd: options.maxCostUsd,
    systemInstructions: SYSTEM_INSTRUCTIONS,
    encryptedArtifactsStored: false,
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);

  console.log(`Benchmark directory: ${directory}`);
  console.log(
    `Model=openai/${model.id}; fixtures=${fixtures.length}; prior=$${recordedCostUsd.toFixed(4)}; ` +
      `cost guard=$${options.maxCostUsd.toFixed(2)}`,
  );

  for (const fixture of fixtures) {
    if (completed.has(fixture.id)) {
      console.log(`[${fixture.id}] already complete; skipping`);
      continue;
    }
    if (recordedCostUsd >= options.maxCostUsd) {
      console.log(`Cost guard reached before ${fixture.id}: $${recordedCostUsd.toFixed(4)}`);
      break;
    }
    console.log(
      `[${fixture.id}] estimatedTokens=${fixture.estimatedTokens}; ` +
        `records=${fixture.authoritativeRecords}; questions=${fixture.questions.length}`,
    );
    const record = await runTrial({ apiKey, model, fixture });
    await appendFile(recordsPath, `${JSON.stringify(record)}\n`);
    recordedCostUsd += record.recordedCostUsd;
    const scores = Object.fromEntries(
      (Object.keys(record.evaluations) as Arm[]).map((arm) => {
        const rows = record.evaluations[arm].scores;
        return [arm, `${rows.filter((row) => row.correct).length}/${rows.length}`];
      }),
    );
    console.log(
      `  scores=${JSON.stringify(scores)} ` +
        `piOut=${record.piDefault.usage?.output}/${record.piDefault.configuredMaxOutputTokens} ` +
        `nativeOut=${record.nativeExtension.usage?.output} ` +
        `trial=$${record.recordedCostUsd.toFixed(4)} cumulative=$${recordedCostUsd.toFixed(4)}`,
    );
  }

  console.log(`Records: ${recordsPath}`);
  console.log(`Recorded cost: $${recordedCostUsd.toFixed(4)}`);
}

export {
  answerSchema,
  evaluateArm,
  messagesAsResponseItems,
  messagesToEntries,
  parseAnswers,
  scoreAnswers,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
