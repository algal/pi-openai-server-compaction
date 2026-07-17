#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  callRemoteCompactionEndpoint,
  type ResponseItem as ExtensionResponseItem,
} from "../../src/remote-compaction.ts";
import {
  buildFixtures,
  type BenchmarkFixture,
  type BenchmarkQuestion,
  type ResponseItem,
} from "./fixtures.ts";

const API_URL = "https://api.openai.com/v1/responses";
const SYSTEM_INSTRUCTIONS =
  "You are the assistant responsible for one synthetic software project. Treat statements marked authoritative as binding, preserve exact identifiers and tool outputs, apply later corrections over superseded values, and maintain task state.";
const SUMMARY_INSTRUCTIONS =
  "Create a compact continuation memory for another model. Preserve every authoritative exact identifier, number, path, checksum, relationship, actual tool result, correction, completed/in-progress/blocked task, blocker, next action, and hard constraint. Explicitly distinguish final corrections from obsolete distractors. Do not answer questions or continue the project. Use concise structured text.";

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

type ResponsesBody = {
  id?: string;
  status?: string;
  output?: Array<Record<string, unknown>>;
  usage?: RawUsage;
  error?: { message?: string };
};

type Arm = "full_context" | "native_compaction" | "text_summary";

type ScoreRow = {
  questionId: string;
  category: string;
  expected: string;
  actual: string;
  correct: boolean;
};

type TrialRecord = {
  fixtureId: string;
  seed: number;
  trial: number;
  model: string;
  nativeBudgetTokens: number;
  nativeCompaction: {
    latencyMs: number;
    usage?: Usage;
    artifactSha256: string;
    artifactBytes: number;
  };
  textSummary: {
    latencyMs: number;
    usage?: Usage;
    responseId?: string;
    text: string;
    characters: number;
  };
  evaluations: Record<Arm, {
    latencyMs: number;
    usage?: Usage;
    responseId?: string;
    rawText: string;
    parsedAnswers: Record<string, string>;
    scores: ScoreRow[];
  }>;
};

type RunOptions = {
  modelId: string;
  fixtureCount: number;
  trials: number;
  outputRoot: string;
};

function parseArgs(argv: string[]): RunOptions {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const modelId = read("--model") ?? "gpt-5.6-sol";
  const fixtureCount = Number(read("--fixtures") ?? "4");
  const trials = Number(read("--trials") ?? "3");
  const outputRoot = resolve(read("--output") ?? join("benchmarks", "native-vs-text", "results"));
  if (!Number.isInteger(fixtureCount) || fixtureCount < 1) throw new Error("--fixtures must be a positive integer");
  if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");
  return { modelId, fixtureCount, trials, outputRoot };
}

function normalizeAnswer(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : String(value ?? "").trim();
}

function usageFromRaw(model: Model<Api>, raw: RawUsage | undefined): Usage | undefined {
  if (!raw) return undefined;
  const cached = raw.input_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    input: Math.max(0, (raw.input_tokens ?? 0) - cached),
    output: raw.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    totalTokens: raw.total_tokens ?? (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
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

export async function requestResponse(
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

export function serializeHistory(items: ResponseItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === "message") {
      const role = String(item.role ?? "unknown");
      const content = Array.isArray(item.content)
        ? item.content
            .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
            .map((part) => String(part.text ?? ""))
            .join("")
        : String(item.content ?? "");
      lines.push(`[${role.toUpperCase()}]: ${content}`);
    } else if (item.type === "function_call") {
      lines.push(`[ASSISTANT TOOL CALL]: ${String(item.name)}(${String(item.arguments)}) [call_id=${String(item.call_id)}]`);
    } else if (item.type === "function_call_output") {
      lines.push(`[TOOL RESULT call_id=${String(item.call_id)}]: ${String(item.output)}`);
    } else {
      lines.push(`[ITEM ${item.type}]: ${JSON.stringify(item)}`);
    }
  }
  return lines.join("\n\n");
}

function evaluationMessage(questions: BenchmarkQuestion[]): ResponseItem {
  const rendered = questions.map((question) => `${question.id}: ${question.question}`).join("\n");
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text:
        "Answer every benchmark question from the supplied conversation memory. " +
        "Return only the JSON object required by the response schema. Each value must be the exact canonical value, with no explanation, labels, units, or extra punctuation.\n\n" +
        rendered,
    }],
  };
}

function answerSchema(questions: BenchmarkQuestion[]): Record<string, unknown> {
  const properties = Object.fromEntries(questions.map((question) => [question.id, { type: "string" }]));
  return {
    type: "json_schema",
    name: "benchmark_answers",
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
      Object.entries(parsed.answers as Record<string, unknown>).map(([key, value]) => [key, normalizeAnswer(value)]),
    );
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { answers?: Record<string, unknown> };
      return Object.fromEntries(
        Object.entries(parsed.answers ?? {}).map(([key, value]) => [key, normalizeAnswer(value)]),
      );
    } catch {
      return {};
    }
  }
}

function scoreAnswers(questions: BenchmarkQuestion[], answers: Record<string, string>): ScoreRow[] {
  return questions.map((question) => {
    const actual = normalizeAnswer(answers[question.id]);
    const expected = normalizeAnswer(question.expected);
    return {
      questionId: question.id,
      category: question.category,
      expected,
      actual,
      correct: actual === expected,
    };
  });
}

export async function evaluateArm(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: BenchmarkFixture;
  context: ResponseItem[];
}): Promise<TrialRecord["evaluations"][Arm]> {
  const response = await requestResponse(params.apiKey, {
    model: params.model.id,
    instructions: SYSTEM_INSTRUCTIONS,
    input: [...params.context, evaluationMessage(params.fixture.questions)],
    tools: params.fixture.tools,
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: null },
    text: { format: answerSchema(params.fixture.questions) },
    max_output_tokens: 4096,
    store: false,
  });
  const text = outputText(response.body);
  const answers = parseAnswers(text);
  return {
    latencyMs: response.latencyMs,
    usage: usageFromRaw(params.model, response.body.usage),
    responseId: response.body.id,
    rawText: text,
    parsedAnswers: answers,
    scores: scoreAnswers(params.fixture.questions, answers),
  };
}

export async function summarizeText(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: BenchmarkFixture;
  maxOutputTokens: number;
  summaryInstructions?: string;
}): Promise<TrialRecord["textSummary"]> {
  const transcript = serializeHistory(params.fixture.history);
  const response = await requestResponse(params.apiKey, {
    model: params.model.id,
    instructions: "You are a context-compression system. Output only the continuation memory.",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `${params.summaryInstructions ?? SUMMARY_INSTRUCTIONS}\n\n<conversation>\n${transcript}\n</conversation>`,
      }],
    }],
    reasoning: { effort: "none", summary: null },
    max_output_tokens: params.maxOutputTokens,
    store: false,
  });
  const text = outputText(response.body);
  return {
    latencyMs: response.latencyMs,
    usage: usageFromRaw(params.model, response.body.usage),
    responseId: response.body.id,
    text,
    characters: text.length,
  };
}

async function compactNative(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: BenchmarkFixture;
}): Promise<{
  contextItem: ResponseItem;
  record: TrialRecord["nativeCompaction"];
  budget: number;
}> {
  const started = Date.now();
  const result = await callRemoteCompactionEndpoint({
    model: params.model,
    apiKey: params.apiKey,
    sessionId: randomUUID(),
    input: params.fixture.history as ExtensionResponseItem[],
    instructions: SYSTEM_INSTRUCTIONS,
    tools: params.fixture.tools,
    parallelToolCalls: false,
    reasoning: { effort: "none", summary: null },
    text: { verbosity: "low" },
  });
  const compactionItem = [...result.output].reverse().find((item) => item.type === "compaction");
  const encryptedContent = compactionItem
    ? (compactionItem as Record<string, unknown>).encrypted_content
    : undefined;
  if (!compactionItem || typeof encryptedContent !== "string") {
    throw new Error(`Native compaction returned no compaction item for ${params.fixture.id}`);
  }
  const encrypted = encryptedContent;
  const budget = result.usage?.output ?? 0;
  if (budget < 16) throw new Error(`Native compaction reported unusable output budget ${budget}`);
  return {
    contextItem: compactionItem as ResponseItem,
    budget,
    record: {
      latencyMs: Date.now() - started,
      usage: result.usage,
      artifactSha256: createHash("sha256").update(encrypted).digest("hex"),
      artifactBytes: Buffer.byteLength(encrypted, "utf8"),
    },
  };
}

function textSummaryContext(summary: string): ResponseItem {
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: `The conversation before the retained tail was compacted into this continuation memory:\n\n<summary>\n${summary}\n</summary>`,
    }],
  };
}

async function runTrial(params: {
  apiKey: string;
  model: Model<Api>;
  fixture: BenchmarkFixture;
  trial: number;
}): Promise<TrialRecord> {
  const native = await compactNative(params);
  const text = await summarizeText({
    apiKey: params.apiKey,
    model: params.model,
    fixture: params.fixture,
    maxOutputTokens: native.budget,
  });

  const armContexts: Record<Arm, ResponseItem[]> = {
    full_context: [...params.fixture.history, ...params.fixture.sharedTail],
    native_compaction: [native.contextItem, ...params.fixture.sharedTail],
    text_summary: [textSummaryContext(text.text), ...params.fixture.sharedTail],
  };
  const order: Arm[] = params.trial % 2 === 0
    ? ["text_summary", "native_compaction", "full_context"]
    : ["full_context", "native_compaction", "text_summary"];
  const evaluations = {} as TrialRecord["evaluations"];
  for (const arm of order) {
    evaluations[arm] = await evaluateArm({
      apiKey: params.apiKey,
      model: params.model,
      fixture: params.fixture,
      context: armContexts[arm],
    });
    await delay(300);
  }

  return {
    fixtureId: params.fixture.id,
    seed: params.fixture.seed,
    trial: params.trial,
    model: params.model.id,
    nativeBudgetTokens: native.budget,
    nativeCompaction: native.record,
    textSummary: text,
    evaluations,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = getModel("openai", options.modelId as Parameters<typeof getModel>[1]);
  if (!model) throw new Error(`Model not found: openai/${options.modelId}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(options.outputRoot, `${timestamp}_${options.modelId}`);
  await mkdir(runDir, { recursive: true });
  const fixtures = buildFixtures(options.fixtureCount);
  const manifest = {
    benchmark: "native-vs-token-matched-text-compaction",
    createdAt: new Date().toISOString(),
    model: `openai/${model.id}`,
    fixtureCount: options.fixtureCount,
    trials: options.trials,
    categories: ["exact_recall", "relational_state", "tool_history", "distractor_resolution", "task_continuation"],
    questionsPerFixture: fixtures[0]?.questions.length ?? 0,
    nativeProtocol: "Responses compaction v2 via compaction_trigger",
    textBudgetRule: "max_output_tokens equals native compaction output_tokens for the paired trial",
    evaluator: "same model, low reasoning, strict JSON schema, exact string scoring",
    encryptedArtifactsStored: false,
  };
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runDir, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
  const recordsPath = join(runDir, "trials.jsonl");

  console.log(`Benchmark run: ${runDir}`);
  console.log(`Model: openai/${model.id}; fixtures=${options.fixtureCount}; trials=${options.trials}`);
  for (const fixture of fixtures) {
    for (let trial = 1; trial <= options.trials; trial++) {
      console.log(`[${fixture.id}] trial ${trial}/${options.trials}: compact, summarize, evaluate`);
      const record = await runTrial({ apiKey, model, fixture, trial });
      await appendFile(recordsPath, `${JSON.stringify(record)}\n`);
      const scores = Object.fromEntries(
        (Object.keys(record.evaluations) as Arm[]).map((arm) => {
          const rows = record.evaluations[arm].scores;
          return [arm, `${rows.filter((row) => row.correct).length}/${rows.length}`];
        }),
      );
      console.log(`  scores=${JSON.stringify(scores)} nativeBudget=${record.nativeBudgetTokens}`);
    }
  }
  console.log(`Completed. Records: ${recordsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
