import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export type BenchmarkCategory =
  | "exact_recall"
  | "relational_state"
  | "tool_history"
  | "distractor_resolution"
  | "task_continuation";

export type BenchmarkQuestion = {
  id: string;
  category: BenchmarkCategory;
  epoch: number;
  question: string;
  expected: string;
};

export type ProductFixture = {
  id: string;
  seed: number;
  density: number;
  targetTokens: number;
  estimatedTokens: number;
  messages: AgentMessage[];
  sharedTail: AgentMessage[];
  tools: Record<string, unknown>[];
  questions: BenchmarkQuestion[];
  authoritativeRecords: number;
};

export type FixtureOptions = {
  seed: number;
  density: number;
  targetTokens?: number;
  questionsPerCategory?: number;
  epochs?: number;
};

type CandidateQuestion = Omit<BenchmarkQuestion, "id">;

const CATEGORIES: BenchmarkCategory[] = [
  "exact_recall",
  "relational_state",
  "tool_history",
  "distractor_resolution",
  "task_continuation",
];

const STATES = ["DONE", "IN_PROGRESS", "BLOCKED", "QUEUED", "VERIFYING"] as const;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function digest(seed: number, namespace: string, index: number): string {
  return createHash("sha256")
    .update(`product-defaults-v1:${seed}:${namespace}:${index}`)
    .digest("hex");
}

function nonce(seed: number, namespace: string, index: number, length = 20): string {
  return digest(seed, namespace, index).slice(0, length);
}

function createClock(seed: number): () => number {
  let timestamp = 1_780_000_000_000 + seed * 1_000_000;
  return () => ++timestamp;
}

function user(text: string, now: () => number): AgentMessage {
  return { role: "user", content: text, timestamp: now() };
}

function assistant(
  content: AssistantMessage["content"],
  now: () => number,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-sol",
    usage: structuredClone(EMPTY_USAGE),
    stopReason: "stop",
    timestamp: now(),
  };
}

function assistantText(text: string, now: () => number): AssistantMessage {
  return assistant([{ type: "text", text }], now);
}

function toolResult(
  toolCallId: string,
  toolName: string,
  output: string,
  now: () => number,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: now(),
  };
}

function estimateMessages(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function buildFiller(
  seed: number,
  epoch: number,
  approximateTokens: number,
  now: () => number,
): AgentMessage[] {
  if (approximateTokens < 24) return [];
  const targetCharacters = Math.max(64, (approximateTokens - 12) * 4);
  const fragments: string[] = [];
  let index = 0;
  let characters = 0;
  while (characters < targetCharacters) {
    const first = nonce(seed + epoch, "archive-a", index, 16);
    const second = nonce(seed + epoch, "archive-b", index, 16);
    const fragment =
      ` Archive notebook ${epoch}-${index} is unrelated to the active project. ` +
      `Its obsolete simulation values ${first} and ${second} are non-authoritative; ` +
      `they update no active key, route, tool result, correction, or task checkpoint.`;
    fragments.push(fragment);
    characters += fragment.length;
    index++;
  }
  const text =
    `UNRELATED ARCHIVAL MATERIAL FOR EPOCH ${epoch}. Ignore it for active-project continuation.` +
    fragments.join("").slice(0, targetCharacters);
  return [
    user(text, now),
    assistantText(`Archived epoch ${epoch}; active-project state is unchanged.`, now),
  ];
}

function selectQuestions(
  fixtureId: string,
  candidates: CandidateQuestion[],
  questionsPerCategory: number,
): BenchmarkQuestion[] {
  const selected: BenchmarkQuestion[] = [];
  for (const category of CATEGORIES) {
    const categoryCandidates = candidates.filter((candidate) => candidate.category === category);
    if (categoryCandidates.length < questionsPerCategory) {
      throw new Error(
        `Not enough ${category} candidates: ${categoryCandidates.length} < ${questionsPerCategory}`,
      );
    }
    for (let index = 0; index < questionsPerCategory; index++) {
      const position = Math.min(
        categoryCandidates.length - 1,
        Math.floor(((index + 0.5) * categoryCandidates.length) / questionsPerCategory),
      );
      const candidate = categoryCandidates[position]!;
      selected.push({
        ...candidate,
        id: `${fixtureId}-${category}-${String(index + 1).padStart(2, "0")}`,
      });
    }
  }
  return selected;
}

export function buildProductFixture(options: FixtureOptions): ProductFixture {
  const {
    seed,
    density,
    targetTokens = 50_000,
    questionsPerCategory = 15,
    epochs = 10,
  } = options;
  if (!Number.isInteger(seed) || seed < 1) throw new Error("seed must be a positive integer");
  if (!Number.isInteger(density) || density < questionsPerCategory) {
    throw new Error("density must be an integer at least as large as questionsPerCategory");
  }
  if (!Number.isInteger(targetTokens) || targetTokens < 25_000) {
    throw new Error("targetTokens must be an integer of at least 25000");
  }
  if (!Number.isInteger(epochs) || epochs < 2) throw new Error("epochs must be at least 2");

  const id = `product-s${String(seed).padStart(3, "0")}-d${density}`;
  const now = createClock(seed);
  const epochMessages: AgentMessage[][] = Array.from({ length: epochs }, () => []);
  const candidates: CandidateQuestion[] = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const messages = epochMessages[epoch]!;
    const indexes = Array.from({ length: density }, (_, index) => index)
      .filter((index) => index % epochs === epoch);

    const exactRecords = indexes.map((index) => {
      const key = `parameter-${seed}-${index + 1}`;
      const value = `value-${nonce(seed, "exact", index, 24)}`;
      candidates.push({
        category: "exact_recall",
        epoch,
        question: `What is the exact authoritative value of ${key}?`,
        expected: value,
      });
      return `${key}=${value}`;
    });
    messages.push(
      user(
        `AUTHORITATIVE EXACT LEDGER, epoch ${epoch}: ${exactRecords.join("; ")}. ` +
          `Preserve every key and value exactly.`,
        now,
      ),
      assistantText(`Recorded the authoritative exact ledger for epoch ${epoch}.`, now),
    );

    const relationRecords = indexes.map((index) => {
      const source = `route-source-${seed}-${index + 1}`;
      const target = `route-target-${nonce(seed, "relation", index, 22)}`;
      candidates.push({
        category: "relational_state",
        epoch,
        question: `Where does ${source} route directly?`,
        expected: target,
      });
      return `${source}->${target}`;
    });
    messages.push(
      user(
        `AUTHORITATIVE DIRECTED ROUTES, epoch ${epoch}: ${relationRecords.join("; ")}. ` +
          `Every arrow is directional and current.`,
        now,
      ),
      assistantText(`Recorded the authoritative routing graph for epoch ${epoch}.`, now),
    );

    const toolCalls: AssistantMessage["content"] = [
      { type: "text", text: `Running authoritative probes for epoch ${epoch}.` },
    ];
    const toolResults: ToolResultMessage[] = [];
    for (const index of indexes) {
      const probe = `probe-${seed}-${index + 1}`;
      const callId = `call-${seed}-${index + 1}-${nonce(seed, "call", index, 8)}`;
      const result = `probe-result-${nonce(seed, "tool", index, 26)}`;
      toolCalls.push({
        type: "toolCall",
        id: callId,
        name: "database_query",
        arguments: { project: seed, probe },
      });
      toolResults.push(
        toolResult(
          callId,
          "database_query",
          `AUTHORITATIVE TOOL OUTPUT ${probe}=${result}`,
          now,
        ),
      );
      candidates.push({
        category: "tool_history",
        epoch,
        question: `What exact authoritative output value did ${probe} return?`,
        expected: result,
      });
    }
    messages.push(assistant(toolCalls, now), ...toolResults);
    messages.push(assistantText(`All authoritative epoch ${epoch} probe results were recorded.`, now));

    const obsoleteRecords: string[] = [];
    const finalRecords: string[] = [];
    for (const index of indexes) {
      const field = `corrected-field-${seed}-${index + 1}`;
      const obsolete = `obsolete-${nonce(seed, "obsolete", index, 20)}`;
      const finalValue = `final-${nonce(seed, "final", index, 24)}`;
      obsoleteRecords.push(`${field}=${obsolete}`);
      finalRecords.push(`${field}=${finalValue}`);
      candidates.push({
        category: "distractor_resolution",
        epoch,
        question: `What is the final authoritative value of ${field}?`,
        expected: finalValue,
      });
    }
    messages.push(
      user(
        `SUPERSEDED CANDIDATES, epoch ${epoch}: ${obsoleteRecords.join("; ")}. ` +
          `Every value in this ledger is obsolete.`,
        now,
      ),
      assistantText(`Marked all epoch ${epoch} candidates obsolete.`, now),
      user(
        `FINAL AUTHORITATIVE CORRECTIONS, epoch ${epoch}: ${finalRecords.join("; ")}. ` +
          `These values replace the superseded candidates exactly.`,
        now,
      ),
      assistantText(`Applied every final authoritative correction for epoch ${epoch}.`, now),
    );

    const taskRecords = indexes.map((index) => {
      const task = `work-item-${seed}-${index + 1}`;
      const state = STATES[Number.parseInt(digest(seed, "state", index).slice(0, 8), 16) % STATES.length]!;
      const receipt = `receipt-${nonce(seed, "receipt", index, 18)}`;
      const next = `next-${nonce(seed, "next", index, 18)}`;
      const canonical = `${state}|receipt=${receipt}|next=${next}`;
      candidates.push({
        category: "task_continuation",
        epoch,
        question:
          `What is the exact current checkpoint for ${task}? ` +
          `Return STATE|receipt=VALUE|next=VALUE.`,
        expected: canonical,
      });
      return `${task}:${canonical}`;
    });
    messages.push(
      user(
        `AUTHORITATIVE WORK CHECKPOINT, epoch ${epoch}: ${taskRecords.join("; ")}. ` +
          `Each state, receipt, and next action is current and must remain associated with its work item.`,
        now,
      ),
      assistantText(`Recorded the authoritative work checkpoint for epoch ${epoch}.`, now),
    );
  }

  const authoritativeTokens = estimateMessages(epochMessages.flat());
  const fillerBudget = Math.max(0, targetTokens - authoritativeTokens);
  const messages: AgentMessage[] = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    messages.push(...epochMessages[epoch]!);
    const epochFillerBudget =
      Math.floor(fillerBudget / epochs) + (epoch < fillerBudget % epochs ? 1 : 0);
    messages.push(...buildFiller(seed, epoch, epochFillerBudget, now));
  }

  const sharedTail: AgentMessage[] = [
    user(
      `Resume active project ${seed}. No authoritative state changed after the last checkpoint. ` +
        `Use final corrections and actual tool outputs; archival notebooks remain irrelevant.`,
      now,
    ),
    assistantText("Ready to continue from the compacted project state.", now),
  ];

  const tools = [
    {
      type: "function",
      name: "database_query",
      description: "Read an authoritative project probe without modifying state",
      parameters: {
        type: "object",
        properties: {
          project: { type: "integer" },
          probe: { type: "string" },
        },
        required: ["project", "probe"],
        additionalProperties: false,
      },
    },
  ];

  return {
    id,
    seed,
    density,
    targetTokens,
    estimatedTokens: estimateMessages(messages),
    messages,
    sharedTail,
    tools,
    questions: selectQuestions(id, candidates, questionsPerCategory),
    authoritativeRecords: candidates.length,
  };
}

export function buildProductFixtures(
  seeds: number[],
  densities: number[],
  targetTokens = 50_000,
  questionsPerCategory = 15,
): ProductFixture[] {
  return densities.flatMap((density) =>
    seeds.map((seed) =>
      buildProductFixture({ seed, density, targetTokens, questionsPerCategory })
    )
  );
}
