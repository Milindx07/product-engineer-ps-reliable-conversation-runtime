import test from "node:test";
import assert from "node:assert/strict";
import { ConversationRuntime } from "../src/runtime.js";
import { InMemoryConversationStore } from "../src/persistence.js";
import { ManualClock } from "../src/scheduler.js";
import {
  acceptingPolicy,
  collectEvents,
  Gate,
  hasCompletedAssistantResponse,
  rejectingPolicy,
  ScriptedProvider,
} from "../src/fakes.js";
import type { OperationalEvent, RunResult, TurnHandle } from "../src/domain.js";

test("successful streaming persists accepted user input and completed assistant response", async () => {
  const provider = new ScriptedProvider([
    { type: "chunk", text: "alpha" },
    { type: "chunk", text: " beta" },
    { type: "done" },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });

  const handle = runtime.startTurn({ content: "hello" }, { timeoutMs: 1_000 });
  const eventPromise = collectEvents(handle.events);
  const result = await handle.completion;
  const events = (await eventPromise) as OperationalEvent[];

  assert.equal(result.terminalState, "completed");
  assert.deepEqual(result.chunks, ["alpha", " beta"]);
  assert.equal(result.partialOutput, "alpha beta");
  assert.equal(provider.calls, 1);
  assert.deepEqual(
    result.persistedRecords.map((record) => [record.role, record.status, record.content]),
    [
      ["user", "accepted_user_input", "hello"],
      ["assistant", "completed_assistant_response", "alpha beta"],
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.chunk").map((event) => event.fields.text),
    ["alpha", " beta"],
  );
  assertSingleTerminalAtEnd(result);
});

test("policy rejection proves provider is not invoked and no successful assistant response is persisted", async () => {
  const provider = new ScriptedProvider([{ type: "chunk", text: "should not stream" }]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: rejectingPolicy, provider, store });

  const handle = runtime.startTurn({ content: "reject this" });
  const result = await handle.completion;

  assert.equal(result.terminalState, "rejected");
  assert.equal(provider.calls, 0);
  assert.equal(result.providerInvoked, false);
  assert.deepEqual(result.persistedRecords, []);
  assert.equal(hasCompletedAssistantResponse(result.persistedRecords), false);
  assertSingleTerminalAtEnd(result);
});

test("cancellation during streaming stops provider consumption and cannot later complete", async () => {
  const firstGate = new Gate();
  const neverOpened = new Gate();
  const provider = new ScriptedProvider([
    { type: "wait", gate: firstGate },
    { type: "chunk", text: "first" },
    { type: "wait", gate: neverOpened },
    { type: "chunk", text: "second" },
    { type: "done" },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });
  const handle = runtime.startTurn({ content: "cancel me" }, { timeoutMs: 1_000 });
  const firstChunk = waitForEvent(handle, "response.chunk");

  firstGate.open();
  await firstChunk;
  assert.equal(handle.cancel("test cancellation"), true);
  const result = await handle.completion;
  neverOpened.open();
  await Promise.resolve();

  assert.equal(result.terminalState, "cancelled");
  assert.deepEqual(result.chunks, ["first"]);
  assert.equal(provider.consumedSteps, 1);
  assert.equal(hasCompletedAssistantResponse(result.persistedRecords), false);
  assertSingleTerminalAtEnd(result);
});

test("timeout uses controlled time and partial output is not a successful assistant response", async () => {
  const clock = new ManualClock();
  const neverOpened = new Gate();
  const provider = new ScriptedProvider([
    { type: "chunk", text: "partial" },
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

  const handle = runtime.startTurn({ content: "timeout please" }, { timeoutMs: 10 });
  const firstChunk = waitForEvent(handle, "response.chunk");
  await firstChunk;
  clock.tick(10);
  const result = await handle.completion;

  assert.equal(result.terminalState, "timed_out");
  assert.deepEqual(result.chunks, ["partial"]);
  assert.equal(hasCompletedAssistantResponse(result.persistedRecords), false);
  assertSingleTerminalAtEnd(result);
});

test("provider failure after partial output is traceable without completed assistant persistence", async () => {
  const provider = new ScriptedProvider([
    { type: "chunk", text: "partial" },
    { type: "fail", error: new Error("provider exploded") },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });

  const handle = runtime.startTurn({ content: "fail after partial" });
  const result = await handle.completion;

  assert.equal(result.terminalState, "failed");
  assert.deepEqual(result.chunks, ["partial"]);
  assert.equal(hasCompletedAssistantResponse(result.persistedRecords), false);
  assert.equal(
    result.trace.some(
      (event) =>
        event.type === "provider.error" &&
        String(event.fields.message).includes("provider exploded"),
    ),
    true,
  );
  assertSingleTerminalAtEnd(result);
});

test("competing terminal transitions produce one winner and observable rejected attempts", async () => {
  const provider = new ScriptedProvider([{ type: "chunk", text: "done" }, { type: "done" }]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });

  const handle = runtime.startTurn({ content: "complete then cancel" });
  const result = await handle.completion;
  const cancelWon = handle.cancel("late cancellation");

  assert.equal(result.terminalState, "completed");
  assert.equal(cancelWon, false);
  assert.deepEqual(result.transitionRejections, [
    {
      attempted: "cancelled",
      winner: "completed",
      reason: "run already reached a terminal state",
    },
  ]);
  assertSingleTerminalAtEnd(result);
});

test("trace redacts representative secret fields and hidden reasoning", async () => {
  const provider = new ScriptedProvider([
    {
      type: "chunk",
      text: "safe",
      metadata: {
        apiKey: "sk-test-secret",
        hiddenReasoning: "private chain of thought",
        nested: {
          authorization: "Bearer private-token",
          publicValue: "visible",
        },
      },
    },
    { type: "done", metadata: { token: "completion-token-secret" } },
  ]);
  const store = new InMemoryConversationStore();
  const runtime = new ConversationRuntime({ policy: acceptingPolicy, provider, store });

  const handle = runtime.startTurn({
    content: "input with secret-looking text is not logged raw",
    metadata: { secret: "user-secret" },
  });
  const result = await handle.completion;
  const traceJson = JSON.stringify(result.trace);

  assert.equal(result.terminalState, "completed");
  assert.equal(traceJson.includes("sk-test-secret"), false);
  assert.equal(traceJson.includes("private chain of thought"), false);
  assert.equal(traceJson.includes("Bearer private-token"), false);
  assert.equal(traceJson.includes("user-secret"), false);
  assert.equal(traceJson.includes("visible"), true);
  assert.equal(traceJson.includes("[redacted]"), true);
  assertSingleTerminalAtEnd(result);
});

function assertSingleTerminalAtEnd(result: RunResult): void {
  const terminalEvents = result.trace.filter((event) => event.type === "run.terminal");
  assert.equal(terminalEvents.length, 1);
  assert.equal(result.trace.at(-1)?.type, "run.terminal");
  assert.equal(terminalEvents[0]?.fields.state, result.terminalState);
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
