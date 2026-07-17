import { createHash } from "node:crypto";

export type BenchmarkCategory =
  | "exact_recall"
  | "relational_state"
  | "tool_history"
  | "distractor_resolution"
  | "task_continuation";

export type BenchmarkQuestion = {
  id: string;
  category: BenchmarkCategory;
  question: string;
  expected: string;
};

export type ResponseItem = Record<string, unknown> & { type: string };

export type BenchmarkFixture = {
  id: string;
  seed: number;
  history: ResponseItem[];
  sharedTail: ResponseItem[];
  tools: Record<string, unknown>[];
  questions: BenchmarkQuestion[];
};

const ADJECTIVES = ["amber", "brisk", "cobalt", "daring", "ember", "frozen", "golden", "hidden"];
const NOUNS = ["falcon", "harbor", "isotope", "juniper", "keystone", "lantern", "meteor", "nebula"];
const REGIONS = ["us-east-2", "eu-west-3", "ap-south-1", "ca-central-1", "sa-east-1", "eu-north-1"];
const PEOPLE = ["Avery", "Blair", "Casey", "Devon", "Ellis", "Finley", "Gray", "Harper"];
const PROBE_INDEXES = new Set([2, 7, 13, 19, 26, 34, 41, 48, 54, 59]);

function digest(seed: number, offset: number, namespace = "token"): string {
  return createHash("sha256").update(`${namespace}:${seed}:${offset}:pi-compaction-benchmark-v1`).digest("hex");
}

function token(seed: number, offset: number): string {
  const hash = digest(seed, offset);
  const adjective = ADJECTIVES[Number.parseInt(hash.slice(0, 2), 16) % ADJECTIVES.length]!.toUpperCase();
  const noun = NOUNS[Number.parseInt(hash.slice(2, 4), 16) % NOUNS.length]!.toUpperCase();
  return `${adjective}-${noun}-${hash.slice(4, 16).toUpperCase()}`;
}

function user(text: string): ResponseItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistant(text: string): ResponseItem {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function toolExchange(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
): ResponseItem[] {
  return [
    { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: callId, output },
  ];
}

function filler(seed: number, index: number): ResponseItem[] {
  const unrelatedProject = `archive-${seed}-${index}`;
  const decoyA = token(seed + index + 17, index % 7);
  const decoyB = token(seed + index + 31, (index + 3) % 7);
  const region = REGIONS[(seed + index) % REGIONS.length];
  const prose = [
    `The archival record ${unrelatedProject} is unrelated to the active project.`,
    `Its obsolete identifier was ${decoyA}, while a simulation mentioned ${decoyB}.`,
    `A synthetic node in ${region} emitted routine telemetry batch ${seed * 1000 + index}.`,
    `These values are distractors and must never override authoritative active-project facts.`,
    `The archive discussion covers capacity planning, queue fairness, observability labels, and retrospective notes.`,
    `No statement in this archival record updates the active project, its ownership, its deployment, or its task plan.`,
  ].join(" ");
  return [user(prose), assistant(`Archived ${unrelatedProject}; no active-project state changed.`)];
}

function addQuestion(
  questions: BenchmarkQuestion[],
  fixtureId: string,
  category: BenchmarkCategory,
  index: number,
  question: string,
  expected: string,
): void {
  questions.push({ id: `${fixtureId}-${category}-${index}`, category, question, expected });
}

export function buildFixture(seed: number): BenchmarkFixture {
  const id = `fixture-${String(seed).padStart(2, "0")}`;
  const launchCode = token(seed, 1);
  const checksum = `sha256:${(0xabc00000 + seed * 7919).toString(16)}${(0xdef00000 + seed * 3571).toString(16)}`;
  const configPath = `/srv/project-${seed}/config/authoritative-${seed}.toml`;
  const databasePort = String(5400 + seed * 13);
  const serviceOwner = PEOPLE[(seed + 1) % PEOPLE.length]!;

  const gateway = `gateway-${seed}`;
  const ledger = `ledger-${seed}`;
  const scheduler = `scheduler-${seed}`;
  const region = REGIONS[seed % REGIONS.length]!;
  const backupRegion = REGIONS[(seed + 2) % REGIONS.length]!;
  const lead = PEOPLE[(seed + 2) % PEOPLE.length]!;
  const manager = PEOPLE[(seed + 4) % PEOPLE.length]!;
  const vaultSlot = `vault/project-${seed}/slot-${20 + seed}`;

  const timeout = String(7000 + seed * 137);
  const failingTest = `reconcile_epoch_${seed}_preserves_order`;
  const editedSymbol = `normalizeProject${seed}Envelope`;
  const rowCount = String(1200 + seed * 43);
  const releaseId = `rel-${202600 + seed}-${token(seed, 2).toLowerCase()}`;

  const finalBranch = `release/project-${seed}-stable`;
  const finalBudget = String(80_000 + seed * 1250);
  const finalQueue = `queue-authoritative-${seed}`;
  const finalOwner = PEOPLE[(seed + 5) % PEOPLE.length]!;
  const finalProtocol = `MEMENTO-${3 + seed}`;

  const doneTask = `schema-${seed}-migration`;
  const inProgressTask = `backfill-project-${seed}`;
  const blockedTask = `cutover-project-${seed}`;
  const blocker = `approval-${token(seed, 4).toLowerCase()}`;
  const nextAction = `verify-batch-${900 + seed}`;
  const hardConstraint = `never-write-region-${backupRegion}`;

  const history: ResponseItem[] = [];
  const questions: BenchmarkQuestion[] = [];

  history.push(
    user(
      `Authoritative active-project briefing for project ${seed}. ` +
        `Launch code: ${launchCode}. Database port: ${databasePort}. ` +
        `Canonical config path: ${configPath}. Artifact checksum: ${checksum}. ` +
        `Initial service owner: ${serviceOwner}. Preserve these exact values.`,
    ),
    assistant("Understood. I will treat those values as authoritative active-project facts."),
  );

  const extraExactFacts = Array.from({ length: 60 }, (_, index) => ({
    key: `parameter-${seed}-${index + 1}`,
    value: token(seed + 50, index + 1),
  }));
  history.push(
    user(
      `Additional authoritative parameter ledger for the active project: ` +
        extraExactFacts.map((fact) => `${fact.key}=${fact.value}`).join("; ") +
        `. Preserve each key/value pair exactly.`,
    ),
    assistant("The additional exact parameter ledger is authoritative."),
  );

  for (let index = 0; index < 35; index++) history.push(...filler(seed, index));

  history.push(
    user(
      `Authoritative topology update: ${gateway} depends directly on ${ledger}; ` +
        `${ledger} depends directly on ${scheduler}. ${scheduler} is deployed in ${region}. ` +
        `${lead} reports to ${manager}. The signing key is stored at ${vaultSlot}.`,
    ),
    assistant("Topology, reporting relationship, deployment region, and vault slot recorded."),
  );

  const extraRelations = Array.from({ length: 60 }, (_, index) => ({
    source: `relation-source-${seed}-${index + 1}`,
    target: `relation-target-${seed}-${index + 1}-${token(seed + 70, index + 1).toLowerCase()}`,
  }));
  history.push(
    user(
      `Additional authoritative direct-routing edges: ` +
        extraRelations.map((edge) => `${edge.source} routes directly to ${edge.target}`).join("; ") +
        `. These are directed edges.`,
    ),
    assistant("The directed routing edges are recorded exactly."),
  );

  for (let index = 35; index < 70; index++) history.push(...filler(seed, index));

  history.push(
    assistant("I will inspect the authoritative runtime state with tools."),
    ...toolExchange(
      `call-read-${seed}`,
      "read",
      { path: configPath },
      `timeout_ms = ${timeout}\nprotocol = "${finalProtocol}"\nsource = "authoritative tool output"`,
    ),
    ...toolExchange(
      `call-test-${seed}`,
      "bash",
      { command: `npm test -- project-${seed}` },
      `FAIL ${failingTest}\nExpected stable ordering but got inversion\nexit code: 1`,
    ),
    ...toolExchange(
      `call-edit-${seed}`,
      "edit",
      { path: `/srv/project-${seed}/src/envelope.ts`, symbol: editedSymbol },
      `Applied edit successfully. Modified symbol: ${editedSymbol}.`,
    ),
    ...toolExchange(
      `call-query-${seed}`,
      "database_query",
      { project: seed, table: "pending_events" },
      `Query completed. Exact row count: ${rowCount}.`,
    ),
    ...toolExchange(
      `call-deploy-${seed}`,
      "deploy",
      { project: seed, region },
      `Dry-run release created. Release ID: ${releaseId}. No production changes made.`,
    ),
    assistant("Tool results recorded; the failing test remains unresolved."),
  );

  const extraToolFacts = Array.from({ length: 60 }, (_, index) => ({
    probe: `probe-${seed}-${index + 1}`,
    result: `tool-result-${token(seed + 90, index + 1).toLowerCase()}`,
  }));
  history.push(assistant("Running additional authoritative probes."));
  for (const [index, fact] of extraToolFacts.entries()) {
    history.push(...toolExchange(
      `call-probe-${seed}-${index + 1}`,
      "database_query",
      { project: seed, probe: fact.probe },
      `Authoritative probe output for ${fact.probe}: ${fact.result}`,
    ));
  }
  history.push(assistant("All additional probe outputs were captured verbatim."));

  for (let index = 70; index < 105; index++) history.push(...filler(seed, index));

  const oldBranch = `prototype/project-${seed}`;
  const oldBudget = String(Number(finalBudget) - 17_000);
  const oldQueue = `queue-obsolete-${seed}`;
  const oldOwner = PEOPLE[(seed + 3) % PEOPLE.length]!;
  const oldProtocol = `LEGACY-${seed}`;
  history.push(
    user(
      `Superseded planning note: branch ${oldBranch}, budget ${oldBudget}, queue ${oldQueue}, ` +
        `owner ${oldOwner}, protocol ${oldProtocol}. This entire note is provisional and will be replaced.`,
    ),
    assistant("Marked the planning note provisional, not final."),
    user(
      `FINAL AUTHORITATIVE CORRECTION for project ${seed}: the branch is ${finalBranch}; ` +
        `the budget is ${finalBudget}; the queue is ${finalQueue}; ownership transfers to ${finalOwner}; ` +
        `the protocol is ${finalProtocol}. These values replace every earlier conflicting value.`,
    ),
    assistant("Final correction applied; all superseded values are obsolete."),
  );

  const extraCorrections = Array.from({ length: 60 }, (_, index) => ({
    field: `corrected-field-${seed}-${index + 1}`,
    obsolete: `obsolete-${token(seed + 110, index + 1).toLowerCase()}`,
    final: `final-${token(seed + 130, index + 1).toLowerCase()}`,
  }));
  history.push(
    user(
      `Superseded correction candidates: ` +
        extraCorrections.map((fact) => `${fact.field}=${fact.obsolete}`).join("; ") +
        `. Every value in this sentence is obsolete.`,
    ),
    assistant("All listed candidates are marked obsolete."),
    user(
      `FINAL AUTHORITATIVE VALUES for the corrected fields: ` +
        extraCorrections.map((fact) => `${fact.field}=${fact.final}`).join("; ") +
        `. These replace the obsolete candidates exactly.`,
    ),
    assistant("The final corrected-field values now override every candidate."),
  );

  for (let index = 105; index < 140; index++) history.push(...filler(seed, index));

  history.push(
    user(
      `Authoritative task checkpoint: DONE=${doneTask}. IN_PROGRESS=${inProgressTask}. ` +
        `BLOCKED=${blockedTask}. The blocker is ${blocker}. ` +
        `The immediate next action is ${nextAction}. Hard constraint: ${hardConstraint}.`,
    ),
    assistant(
      `Checkpoint recorded. I must continue ${inProgressTask}, respect ${hardConstraint}, ` +
        `and not attempt ${blockedTask} until ${blocker} is resolved.`,
    ),
  );

  const extraTaskFacts = Array.from({ length: 60 }, (_, index) => ({
    task: `work-item-${seed}-${index + 1}`,
    state: ["DONE", "IN_PROGRESS", "BLOCKED", "QUEUED", "VERIFYING"][
      Number.parseInt(digest(seed, index, "state").slice(0, 4), 16) % 5
    ]!,
  }));
  history.push(
    user(
      `Additional authoritative work ledger: ` +
        extraTaskFacts.map((fact) => `${fact.task}=${fact.state}`).join("; ") +
        `. Preserve each work item's current state.`,
    ),
    assistant("The additional work ledger is part of the continuation checkpoint."),
  );

  for (let index = 140; index < 165; index++) history.push(...filler(seed, index));

  const sharedTail: ResponseItem[] = [
    user(
      `We are resuming project ${seed}. No authoritative facts changed after the checkpoint. ` +
        `Use the latest corrections and actual tool outputs rather than archival distractors.`,
    ),
    assistant("Ready to continue from the authoritative checkpoint."),
  ];

  addQuestion(questions, id, "exact_recall", 1, "What is the exact launch code?", launchCode);
  addQuestion(questions, id, "exact_recall", 2, "What is the database port?", databasePort);
  addQuestion(questions, id, "exact_recall", 3, "What is the canonical config path?", configPath);
  addQuestion(questions, id, "exact_recall", 4, "What is the exact artifact checksum?", checksum);
  addQuestion(questions, id, "exact_recall", 5, "Who was the initial service owner?", serviceOwner);

  addQuestion(questions, id, "relational_state", 1, `Which component does ${gateway} directly depend on?`, ledger);
  addQuestion(questions, id, "relational_state", 2, `Which component does ${ledger} directly depend on?`, scheduler);
  addQuestion(questions, id, "relational_state", 3, `In which region is ${scheduler} deployed?`, region);
  addQuestion(questions, id, "relational_state", 4, `Who does ${lead} report to?`, manager);
  addQuestion(questions, id, "relational_state", 5, "What is the signing-key vault slot?", vaultSlot);

  addQuestion(questions, id, "tool_history", 1, "What timeout_ms value did the read tool return?", timeout);
  addQuestion(questions, id, "tool_history", 2, "What exact test name failed?", failingTest);
  addQuestion(questions, id, "tool_history", 3, "Which symbol did the edit tool modify?", editedSymbol);
  addQuestion(questions, id, "tool_history", 4, "What exact row count did the database query return?", rowCount);
  addQuestion(questions, id, "tool_history", 5, "What release ID did the deploy dry-run create?", releaseId);

  addQuestion(questions, id, "distractor_resolution", 1, "What is the final authoritative branch?", finalBranch);
  addQuestion(questions, id, "distractor_resolution", 2, "What is the final authoritative budget?", finalBudget);
  addQuestion(questions, id, "distractor_resolution", 3, "What is the final authoritative queue?", finalQueue);
  addQuestion(questions, id, "distractor_resolution", 4, "Who is the final owner after transfer?", finalOwner);
  addQuestion(questions, id, "distractor_resolution", 5, "What is the final authoritative protocol?", finalProtocol);

  addQuestion(questions, id, "task_continuation", 1, "Which task is done?", doneTask);
  addQuestion(questions, id, "task_continuation", 2, "Which task is in progress?", inProgressTask);
  addQuestion(questions, id, "task_continuation", 3, "Which task is blocked?", blockedTask);
  addQuestion(questions, id, "task_continuation", 4, "What exact blocker prevents cutover?", blocker);
  addQuestion(questions, id, "task_continuation", 5, "What is the immediate next action?", nextAction);

  extraExactFacts.filter((_, index) => PROBE_INDEXES.has(index)).forEach((fact, index) =>
    addQuestion(questions, id, "exact_recall", index + 6, `What is the exact value of ${fact.key}?`, fact.value));
  extraRelations.filter((_, index) => PROBE_INDEXES.has(index)).forEach((edge, index) =>
    addQuestion(questions, id, "relational_state", index + 6, `Where does ${edge.source} route directly?`, edge.target));
  extraToolFacts.filter((_, index) => PROBE_INDEXES.has(index)).forEach((fact, index) =>
    addQuestion(questions, id, "tool_history", index + 6, `What exact output value did ${fact.probe} return?`, fact.result));
  extraCorrections.filter((_, index) => PROBE_INDEXES.has(index)).forEach((fact, index) =>
    addQuestion(questions, id, "distractor_resolution", index + 6, `What is the final value of ${fact.field}?`, fact.final));
  extraTaskFacts.filter((_, index) => PROBE_INDEXES.has(index)).forEach((fact, index) =>
    addQuestion(questions, id, "task_continuation", index + 6, `What is the current state of ${fact.task}?`, fact.state));

  const tools = [
    { type: "function", name: "read", description: "Read a file", parameters: { type: "object" } },
    { type: "function", name: "bash", description: "Run tests", parameters: { type: "object" } },
    { type: "function", name: "edit", description: "Edit code", parameters: { type: "object" } },
    { type: "function", name: "database_query", description: "Query a database", parameters: { type: "object" } },
    { type: "function", name: "deploy", description: "Create a deployment dry-run", parameters: { type: "object" } },
  ];

  return { id, seed, history, sharedTail, tools, questions };
}

export function buildFixtures(count: number): BenchmarkFixture[] {
  return Array.from({ length: count }, (_, index) => buildFixture(index + 1));
}
