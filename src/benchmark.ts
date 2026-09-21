import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationRuntime } from "./runtime.js";
import { InMemoryConversationStore } from "./persistence.js";
import { ManualClock } from "./scheduler.js";
import {
  acceptingPolicy,
  Gate,
  hasCompletedAssistantResponse,
  rejectingPolicy,
  ScriptedProvider,
} from "./fakes.js";
import type { RunResult, TerminalState, TurnHandle } from "./domain.js";

type ScenarioName =
  | "success"
  | "rejection"
  | "cancellation"
  | "timeout"
  | "provider_failure";

interface ScenarioRun {
  scenario: ScenarioName;
  result: RunResult;
}

const terminalStates: TerminalState[] = [
  "completed",
  "rejected",
  "cancelled",
  "timed_out",
  "failed",
];

export async function runBenchmark(iterations: number): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];

  for (let index = 0; index < iterations; index += 1) {
    runs.push(await runSuccess(index));
    runs.push(await runRejection(index));
    runs.push(await runCancellation(index));
    runs.push(await runTimeout(index));
    runs.push(await runProviderFailure(index));
  }

  verifyBenchmark(runs);
  return runs;
}

function makeRuntime(provider: ScriptedProvider, policy = acceptingPolicy) {
  const store = new InMemoryConversationStore();
  return {
    store,
    runtime: new ConversationRuntime({
      policy,
      provider,
      store,
    }),
  };
}

async function runSuccess(index: number): Promise<ScenarioRun> {
  const provider = new ScriptedProvider([
    { type: "chunk", text: `ok-${index}-a` },
    { type: "chunk", text: `-b` },
    { type: "done" },
  ]);
  const { runtime } = makeRuntime(provider);
  const handle = runtime.startTurn({ content: `hello ${index}` }, { timeoutMs: 1_000 });
  drainEvents(handle);
  return { scenario: "success", result: await handle.completion };
}

async function runRejection(index: number): Promise<ScenarioRun> {
  const provider = new ScriptedProvider([{ type: "chunk", text: "must-not-run" }]);
  const { runtime } = makeRuntime(provider, rejectingPolicy);
  const handle = runtime.startTurn({ content: `blocked ${index}` }, { timeoutMs: 1_000 });
  drainEvents(handle);
  return { scenario: "rejection", result: await handle.completion };
}

async function runCancellation(index: number): Promise<ScenarioRun> {
  const gate = new Gate();
  const neverOpened = new Gate();
  const provider = new ScriptedProvider([
    { type: "wait", gate },
    { type: "chunk", text: `partial-${index}` },
    { type: "wait", gate: neverOpened },
    { type: "chunk", text: "must-not-appear" },
    { type: "done" },
  ]);
  const { runtime } = makeRuntime(provider);
  const handle = runtime.startTurn({ content: `cancel ${index}` }, { timeoutMs: 1_000 });
  const firstChunk = waitForEvent(handle, "response.chunk");
  gate.open();
  await firstChunk;
  handle.cancel("benchmark cancellation");
  return { scenario: "cancellation", result: await handle.completion };
}

async function runTimeout(index: number): Promise<ScenarioRun> {
  const clock = new ManualClock();
  const neverOpened = new Gate();
  const provider = new ScriptedProvider([
    { type: "chunk", text: `partial-timeout-${index}` },
    { type: "wait", gate: neverOpened },
    { type: "done" },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({
    policy: acceptingPolicy,
    provider,
    store,
    scheduler: clock,
  });

  const handle = runtime.startTurn({ content: `timeout ${index}` }, { timeoutMs: 25 });
  await waitForEvent(handle, "response.chunk");
  clock.tick(25);
  return { scenario: "timeout", result: await handle.completion };
}

async function runProviderFailure(index: number): Promise<ScenarioRun> {
  const provider = new ScriptedProvider([
    { type: "chunk", text: `partial-failure-${index}` },
    { type: "fail", error: new Error("deterministic provider failure") },
  ]);
  const { runtime } = makeRuntime(provider);
  const handle = runtime.startTurn({ content: `fail ${index}` }, { timeoutMs: 1_000 });
  drainEvents(handle);
  return { scenario: "provider_failure", result: await handle.completion };
}

function verifyBenchmark(runs: ScenarioRun[]): void {
  const failures: string[] = [];

  for (const run of runs) {
    const terminalEvents = run.result.trace.filter((event) => event.type === "run.terminal");
    if (terminalEvents.length !== 1) {
      failures.push(`${run.scenario}/${run.result.runId}: expected exactly one terminal event`);
    }

    const terminalIndex = run.result.trace.findIndex((event) => event.type === "run.terminal");
    if (terminalIndex !== run.result.trace.length - 1) {
      failures.push(`${run.scenario}/${run.result.runId}: trace has events after terminal`);
    }

    if (run.result.terminalState !== terminalEvents[0]?.fields.state) {
      failures.push(`${run.scenario}/${run.result.runId}: result and trace terminal mismatch`);
    }

    if (run.scenario === "rejection" && run.result.providerInvoked) {
      failures.push(`${run.scenario}/${run.result.runId}: rejected run invoked provider`);
    }

    if (
      ["cancellation", "timeout", "provider_failure"].includes(run.scenario) &&
      hasCompletedAssistantResponse(run.result.persistedRecords)
    ) {
      failures.push(
        `${run.scenario}/${run.result.runId}: non-success run persisted successful assistant response`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Benchmark verification failed:\n${failures.join("\n")}`);
  }
}

function summarize(runs: ScenarioRun[]): string {
  const counts = Object.fromEntries(terminalStates.map((state) => [state, 0])) as Record<
    TerminalState,
    number
  >;
  const scenarioCounts = new Map<ScenarioName, number>();

  for (const run of runs) {
    counts[run.result.terminalState] += 1;
    scenarioCounts.set(run.scenario, (scenarioCounts.get(run.scenario) ?? 0) + 1);
  }

  return JSON.stringify(
    {
      totalRuns: runs.length,
      scenarioCounts: Object.fromEntries(scenarioCounts),
      terminalStateCounts: counts,
      verified: {
        exactlyOneTerminalState: true,
        rejectedRunsNeverInvokeProvider: true,
        nonSuccessRunsNeverPersistCompletedAssistantResponse: true,
        noEventsAfterTerminal: true,
        liveModelRequired: false,
      },
    },
    null,
    2,
  );
}

function waitForEvent(handle: TurnHandle, type: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        for await (const event of handle.events) {
          if (event.type === type) {
            resolve();
          }
        }
      } catch (error) {
        reject(error);
      }
    })();
  });
}

function drainEvents(handle: TurnHandle): void {
  void (async () => {
    for await (const _event of handle.events) {
      // Drained so producers never depend on a consumer being attached.
    }
  })();
}

function parseIterations(argv: string[]): number {
  const flagIndex = argv.indexOf("--iterations");
  if (flagIndex === -1) {
    return 10;
  }

  const parsed = Number(argv[flagIndex + 1]);
  if (!Number.isInteger(parsed) || parsed < 10) {
    throw new Error("--iterations must be an integer >= 10");
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const iterations = parseIterations(process.argv.slice(2));
  const runs = await runBenchmark(iterations);
  console.log(summarize(runs));
}
