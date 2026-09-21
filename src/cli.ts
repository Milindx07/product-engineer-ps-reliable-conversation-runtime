import { ConversationRuntime } from "./runtime.js";
import { InMemoryConversationStore } from "./persistence.js";
import { ManualClock } from "./scheduler.js";
import {
  acceptingPolicy,
  Gate,
  rejectingPolicy,
  ScriptedProvider,
} from "./fakes.js";
import type { OperationalEvent, RunResult, TurnHandle } from "./domain.js";

async function runDemo(): Promise<void> {
  console.log("Bounded conversation runtime demo\n");

  await demoSuccess();
  await demoRejection();
  await demoCancellation();
  await demoProviderFailure();
}

async function demoSuccess(): Promise<void> {
  const provider = new ScriptedProvider([
    { type: "chunk", text: "Hello" },
    { type: "chunk", text: ", " },
    { type: "chunk", text: "world." },
    { type: "done", metadata: { providerRequestId: "fake-success-1" } },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });
  const handle = runtime.startTurn({ content: "Say hello" }, { timeoutMs: 1_000 });

  console.log("1. Successful streamed turn");
  const result = await printStreamAndWait(handle);
  printRecordsAndTrace(result);
}

async function demoRejection(): Promise<void> {
  const provider = new ScriptedProvider([{ type: "chunk", text: "must-not-run" }]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({
    policy: rejectingPolicy,
    provider,
    store,
  });
  const handle = runtime.startTurn({ content: "This should be rejected" });

  console.log("\n2. Policy rejection bypassing provider");
  const result = await printStreamAndWait(handle);
  console.log(`Provider invoked: ${result.providerInvoked}`);
  printRecordsAndTrace(result);
}

async function demoCancellation(): Promise<void> {
  const gate = new Gate();
  const neverOpened = new Gate();
  const provider = new ScriptedProvider([
    { type: "wait", gate },
    { type: "chunk", text: "partial output before cancellation" },
    { type: "wait", gate: neverOpened },
    { type: "chunk", text: "not consumed" },
    { type: "done" },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });
  const handle = runtime.startTurn({ content: "Start then cancel" }, { timeoutMs: 1_000 });

  console.log("\n3. Cancellation during streaming");
  const printer = printEvents(handle);
  gate.open();
  await printer.firstChunk;
  handle.cancel("demo cancellation");
  const result = await handle.completion;
  await printer.done;
  printRecordsAndTrace(result);

  const timeoutProvider = new ScriptedProvider([
    { type: "chunk", text: "partial before timeout" },
    { type: "wait", gate: new Gate() },
    { type: "done" },
  ]);
  const timeoutStore = new InMemoryConversationStore();
  const clock = new ManualClock();
  const timeoutRuntime = new ConversationRuntime({
    policy: acceptingPolicy,
    provider: timeoutProvider,
    store: timeoutStore,
    scheduler: clock,
  });
  const timeoutHandle = timeoutRuntime.startTurn(
    { content: "Start then timeout" },
    { timeoutMs: 50 },
  );
  const timeoutPrinter = printEvents(timeoutHandle);
  await timeoutPrinter.firstChunk;
  clock.tick(50);
  const timeoutResult = await timeoutHandle.completion;
  await timeoutPrinter.done;
  console.log("\n3b. Timeout during streaming");
  printRecordsAndTrace(timeoutResult);
}

async function demoProviderFailure(): Promise<void> {
  const provider = new ScriptedProvider([
    {
      type: "chunk",
      text: "partial output before failure",
      metadata: {
        apiKey: "sk-demo-secret",
        hiddenReasoning: "private reasoning must not appear",
        publicProviderDetail: "safe-to-show",
      },
    },
    { type: "fail", error: new Error("deterministic provider failure") },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });
  const handle = runtime.startTurn({ content: "Trigger provider failure" });

  console.log("\n4. Provider failure after partial output");
  const result = await printStreamAndWait(handle);
  printRecordsAndTrace(result);
}

async function printStreamAndWait(handle: TurnHandle): Promise<RunResult> {
  const printer = printEvents(handle);
  const result = await handle.completion;
  await printer.done;
  return result;
}

function printEvents(handle: TurnHandle): {
  firstChunk: Promise<void>;
  done: Promise<void>;
} {
  let resolveFirstChunk!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });
  let sawChunk = false;

  const done = (async () => {
    for await (const event of handle.events) {
      if (event.type === "response.chunk") {
        sawChunk = true;
        resolveFirstChunk();
        process.stdout.write(String(event.fields.text));
      }
    }
    if (!sawChunk) {
      resolveFirstChunk();
    }
    process.stdout.write("\n");
  })();

  return { firstChunk, done };
}

function printRecordsAndTrace(result: RunResult): void {
  console.log(`Terminal state: ${result.terminalState}`);
  console.log("Persisted records:");
  console.log(
    JSON.stringify(
      result.persistedRecords.map((record) => ({
        role: record.role,
        status: record.status,
        content: record.content,
      })),
      null,
      2,
    ),
  );
  console.log("Ordered trace:");
  console.log(JSON.stringify(result.trace.map(compactTraceEvent), null, 2));
}

function compactTraceEvent(event: OperationalEvent): Record<string, unknown> {
  return {
    sequence: event.sequence,
    type: event.type,
    fields: event.fields,
  };
}

if (process.argv[2] === "demo") {
  await runDemo();
} else {
  console.log("Usage: node dist/src/cli.js demo");
}
