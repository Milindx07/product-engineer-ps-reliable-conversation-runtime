# Product Engineering Challenge Submission

## Candidate

- **Name:** Milind Kumar
- **Email:** milansmbp@gmail.com
- **GitHub:** https://github.com/Milindx07
- **Selected problem:** 05 - Reliable Conversation Runtime
- **Demo video:** https://drive.google.com/file/d/1-2j5ImBPnHaUsybMgLxvcl8J0X3HTW5V/view?usp=sharing
- **Live demo:** local Node/SSE demo at `http://localhost:5173` after running `npm run live`

## Run the project

Prerequisites:

- Node.js 22 or newer
- npm

Install dependencies:

```text
git clone https://github.com/Milindx07/product-engineer-ps-reliable-conversation-runtime.git
cd product-engineer-ps-reliable-conversation-runtime
npm install
```

Run the CLI demo:

```text
npm run demo
```

Run the browser live demo:

```text
npm run live
```

Then open:

```text
http://localhost:5173
```

This is a local live demo rather than a hosted static link because it runs the TypeScript/Node runtime and streams events over Server-Sent Events.

On Windows, the reviewer can also double-click:

```text
start-live-demo.bat
```

Successful scenario:

- CLI: run `npm run demo` and review section `1. Successful streamed turn`.
- Browser: run `npm run live`, open `http://localhost:5173`, and click `Run Success`.

Failure and recovery scenarios:

- `Run Rejection` shows policy rejection before provider invocation.
- `Run Cancellation` shows cancellation during active streaming.
- `Run Timeout` shows deadline enforcement during streaming.
- `Run Failure` shows provider failure after partial output.

No environment variables are required. No model API key is required.

## Run the tests

```text
npm test
```

Observed latest local result:

```text
7 tests passed
0 tests failed
```

The deterministic tests cover:

- Successful streaming and persistence
- Policy rejection proving the provider was not invoked
- Cancellation during streaming
- Timeout using controlled time through `ManualClock`
- Provider failure after partial output
- Competing terminal-state transitions
- Trace redaction of representative secret and hidden-reasoning fields

## Acceptance scenarios and verification

Completed acceptance scenarios:

- Given the policy accepts input and the provider emits valid chunks, chunks stream in order, the run completes once, and the documented conversation records are persisted.
- Given the policy rejects input, the provider is never called, the rejection is visible, and no successful assistant response is persisted.
- Given the provider is still streaming and cancellation is requested, provider consumption stops, the run becomes `cancelled`, and it cannot later transition to `completed`.
- Given the provider does not finish before the configured duration, execution stops, the run becomes `timed_out`, and partial output is not persisted as a successful assistant response.
- Given the provider fails after partial output, the failure and partial-stream history are traceable without recording a successful completed response.
- Given completion, timeout, or cancellation can occur close together, exactly one terminal state wins and later transition attempts are rejected observably.
- Given a run reaches any terminal state, its trace explains what occurred without exposing secrets or hidden model reasoning.

Problem-specific verification benchmark:

```text
npm run benchmark
```

Observed latest local benchmark result:

```json
{
  "totalRuns": 50,
  "scenarioCounts": {
    "success": 10,
    "rejection": 10,
    "cancellation": 10,
    "timeout": 10,
    "provider_failure": 10
  },
  "terminalStateCounts": {
    "completed": 10,
    "rejected": 10,
    "cancelled": 10,
    "timed_out": 10,
    "failed": 10
  },
  "verified": {
    "exactlyOneTerminalState": true,
    "rejectedRunsNeverInvokeProvider": true,
    "nonSuccessRunsNeverPersistCompletedAssistantResponse": true,
    "noEventsAfterTerminal": true,
    "liveModelRequired": false
  }
}
```

The demo shows these contrasting outcomes:

- Successful completion persists both accepted user input and completed assistant response.
- Policy rejection terminates as `rejected`, bypasses provider invocation, and persists no assistant response.
- Cancellation aborts provider consumption through `AbortSignal`, terminates as `cancelled`, and does not persist completed assistant output.
- Timeout terminates as `timed_out`; partial output remains visible in trace/result but is not represented as a completed assistant record.
- Provider failure terminates as `failed`; partial stream history remains traceable and secret fields are redacted.

## Architecture and data flow

Main components:

- `Policy`: evaluates user input before provider invocation.
- `ModelProvider`: abstracts streamed provider output through async iterable events.
- `ConversationRuntime`: owns orchestration, state transitions, timeout, cancellation, provider consumption, trace recording, and persistence boundaries.
- `ConversationStore`: persists externally honest conversation records.
- `TraceRecorder`: records ordered operational events and redacts sensitive or hidden-reasoning fields.
- CLI/live demo: presentation layers that consume runtime events without owning state semantics.

Data flow:

```text
User input
  -> ConversationRuntime.startTurn()
  -> Policy.evaluate()
  -> rejected terminal state OR accepted user persistence
  -> ModelProvider.stream()
  -> ordered chunks + trace events
  -> completed/cancelled/timed_out/failed terminal state
  -> assistant response persisted only if completed
```

The browser live demo uses Server-Sent Events to stream the same runtime events to the UI, so the UI demonstrates the actual runtime rather than static mock output.

## Technology choices

Stack:

- TypeScript for explicit state and interface modeling.
- Node.js built-in test runner to avoid unnecessary dependencies.
- Async iterables for provider streaming because they naturally model chunked provider output and cancellation checks.
- `AbortSignal` for cancellation because it is a standard JavaScript/Node cancellation primitive.
- In-memory persistence because the assignment evaluates orchestration semantics, not database infrastructure.
- Minimal HTTP server plus Server-Sent Events for the live demo because it keeps presentation separate from runtime logic.

Alternatives considered:

- Express/Fastify: not used because the live demo only needs a small HTTP/SSE surface.
- Jest/Vitest: not used because Node's built-in test runner is enough for deterministic unit tests.
- A real model provider: not included because live provider integration is optional, and deterministic fake providers better prove state-machine correctness.

Trade-offs:

- Persistence is inspectable and deterministic but not durable.
- The browser interface is intentionally simple because this is a bounded-runtime correctness exercise, not a polished chat-interface exercise.

## Important decisions

1. Terminal states are controlled by one guarded transition function. The first terminal outcome wins, and later terminal attempts are captured as transition rejections instead of mutating the result.
2. Accepted user input is persisted before provider streaming, but assistant output is persisted only after provider `done` and only when the run reaches `completed`.
3. Partial output from cancelled, timed-out, or failed runs remains visible in runtime results and traces but is not written as a successful assistant conversation record.
4. Trace events contain operational diagnostics, not private hidden reasoning. User input is represented by length/hash in the trace, and sensitive keys are redacted recursively.

## Assumptions and limitations

Assumptions:

- One runtime invocation manages one conversational turn.
- Providers are cooperative and observe `AbortSignal`.
- The benchmark should be deterministic and independent of live model latency or output quality.

Limitations:

- The submitted store is in-memory, not a durable database.
- Authentication, billing, cloud deployment, production metrics infrastructure, long-term memory, and semantic retrieval are intentionally out of scope.
- No live model integration is included because the assignment marks it optional.
- The UI is a basic live demo rather than a polished chat product.

If product requirements allowed users to keep and continue from partial output after cancellation, I would add a separate `partial_assistant_draft` record type with explicit status and continuation metadata. I would not reuse the completed assistant record shape, because clients and downstream systems must be able to distinguish partial/draft content from completed conversation history.

## Production and scale

What the submitted implementation does now:

- Runs deterministic single-turn orchestration.
- Enforces policy-before-provider behavior.
- Streams provider chunks.
- Supports cancellation and timeout.
- Persists only externally honest records.
- Produces sanitized operational traces.
- Verifies behavior through tests and a repeatable benchmark.

What I would change first for production:

- Replace the in-memory store with transactional durable persistence. The assistant commit and terminal outcome should be written atomically or with an auditable recovery process.
- Add idempotent run creation and cancellation endpoints so clients can safely retry requests.
- Add output size limits and stream backpressure so a provider cannot exhaust memory.
- Add structured logs and metrics derived from sanitized trace events.
- Add provider adapters for real model APIs while preserving the same `ModelProvider` interface.
- Add durable trace retention policies that separate operational diagnostics from user-visible conversation history.

## AI usage

AI tools used:

- ChatGPT/Codex was used to help implement the TypeScript project, tests, benchmark, CLI demo, browser live demo, and documentation.

Review and validation:

- The official problem statement and submission template were checked against the implementation.
- The project was validated with `npm run check`.
- Deterministic tests use fake providers and a manual clock, so they do not rely on arbitrary long sleeps or paid model APIs.
- Benchmark output was observed locally and included above.
- Source files were kept small and separated by responsibility so runtime, provider abstraction, persistence, trace, policy, and presentation are reviewable independently.

## Credibility note

One product/system I can publicly describe from this submission is the reliable conversation runtime itself:

- **Problem solved:** A conversational product must not treat partial, rejected, cancelled, timed-out, or failed generations as successful completed assistant turns.
- **Personal contribution:** I designed and implemented the runtime boundary, provider interface, policy gate, terminal-state machine, cancellation and timeout paths, persistence semantics, trace redaction, deterministic tests, benchmark, CLI demo, and browser live demo.
- **Scale or operational complexity:** The implementation exercises 50 deterministic benchmark runs per verification command across five terminal outcomes and validates invariants that matter when the same runtime sits behind web or mobile clients.
- **Difficult engineering or product decision:** The key decision was to persist accepted user input separately from completed assistant output, while keeping partial output inspectable only through trace/result data. This prevents product history from silently misrepresenting cancelled, timed-out, or failed model calls as successful assistant responses.
- **Public evidence:** The submitted GitHub repository and benchmark/test output provide reproducible evidence. Confidential or unrelated prior work is not required to evaluate this implementation.
