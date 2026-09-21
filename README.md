# Bounded Conversation Runtime

This project implements a bounded TypeScript/Node.js runtime that manages one streamed conversational turn from request through exactly one terminal state.

It is intentionally provider-agnostic. Tests and the benchmark use deterministic fake providers, so no paid model API is required.

## Commands

```bash
npm install
npm test
npm run benchmark
npm run demo
npm run live
npm run check
```

## Live Demo

This project includes a local browser demo for the reliable conversation runtime.

```bash
git clone https://github.com/Milindx07/product-engineer-ps-reliable-conversation-runtime.git
cd product-engineer-ps-reliable-conversation-runtime
npm install
npm run live
```

Then open:

```text
http://localhost:5173
```

If port `5173` is already busy, the server automatically tries the next available port and prints the exact URL to open, such as `http://localhost:5174`.

The live demo is local because the app runs a Node.js Server-Sent Events endpoint. It is not a static GitHub Pages site. In the demo, click `Run Success`, `Run Rejection`, `Run Cancellation`, `Run Timeout`, `Run Failure`, and `Run Benchmark`.

`npm run benchmark` runs at least 10 deterministic iterations each for successful completion, policy rejection, cancellation, timeout, and provider failure.

`npm run live` starts a local browser demo and prints the local URL.

On Windows, `start-live-demo.bat` starts the live demo and prints the local URL to open.

## Component Responsibilities

- `Policy`: evaluates user input before any provider invocation. A rejected policy decision terminates the run as `rejected`.
- `ModelProvider`: exposes an async stream of provider events. Providers receive an `AbortSignal` and must stop promptly when it is aborted.
- `ConversationRuntime`: owns orchestration, state transitions, timeout, cancellation, provider consumption, trace recording, and persistence boundaries.
- `ConversationStore`: persists externally representable conversation records. The included implementation is in-memory for deterministic tests and demos.
- `TraceRecorder`: records ordered operational events and redacts secret or hidden-reasoning fields.
- CLI/presentation: consumes runtime events and prints chunks, traces, and persisted records. It does not own state semantics.

## Persistence Boundary

- Rejected input: no conversation record is committed and the provider is never called.
- Accepted input: the user input is committed as an accepted user record before provider streaming starts.
- Streamed chunks: partial assistant output is streamed and traceable, but not persisted as a successful assistant conversation record.
- Completed output: the assistant response is committed only after provider `done` is observed and before the single `completed` terminal event is recorded.
- Cancelled, timed-out, and failed runs: keep any accepted user input, keep partial output in the run result/trace, and never commit a successful assistant response.

If product requirements allowed a user to keep and continue from partial output after cancellation, persistence should add a separate `partial_assistant_draft` record type with explicit status and continuation metadata. It should not reuse the completed assistant record shape, because downstream clients must be able to distinguish draft/partial content from completed conversation history.

## Terminal States and Transitions

Allowed terminal states are:

- `completed`
- `rejected`
- `cancelled`
- `timed_out`
- `failed`

The runtime starts in `created`, evaluates policy, optionally streams from the provider, and then commits exactly one terminal state. Terminal transition is guarded by a single state-machine function. The first terminal transition wins. Later terminal attempts are rejected into `transitionRejections` for inspection without appending trace events after the terminal event.

## Cancellation

`startTurn()` returns a handle with `cancel(reason)`. Cancellation records a cancellation request, aborts the provider signal, and attempts the `cancelled` terminal transition. Cooperative providers stop by observing the `AbortSignal`.

## Timeouts

Each run can receive `timeoutMs`. The runtime schedules a deadline through an injectable scheduler. Production use defaults to real timers; tests use `ManualClock`, so timeout behavior is deterministic and does not rely on arbitrary sleeps.

## Operational Trace

Trace events include:

- Run start and terminal outcome
- Policy start/decision
- Persistence commits
- Provider start/chunks/done/errors
- Cancellation request
- Timeout deadline

Trace fields are diagnostic but do not expose hidden chain-of-thought. User input is represented by length and SHA-256 hash, not raw text. Fields with names such as `apiKey`, `token`, `secret`, `authorization`, `password`, `hiddenReasoning`, `chainOfThought`, or `cot` are redacted.

## Web or Mobile Use

The same runtime can sit behind a web or mobile client by exposing:

- `POST /turns` to start a turn and return a run id
- Server-sent events or WebSocket messages for ordered runtime events and chunks
- `POST /turns/:runId/cancel` to call `cancel()`
- `GET /turns/:runId/trace` for sanitized operational trace
- Conversation history from the persistence layer, which contains only externally honest records

The orchestration and state machine remain unchanged; only the presentation and transport layer changes.
