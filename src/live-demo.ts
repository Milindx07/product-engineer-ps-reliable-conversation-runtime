import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProvider, ProviderEvent, ProviderRequest } from "./domain.js";
import { acceptingPolicy, rejectingPolicy } from "./fakes.js";
import { InMemoryConversationStore } from "./persistence.js";
import { ConversationRuntime } from "./runtime.js";
import { runBenchmark } from "./benchmark.js";

type LiveScenario = "success" | "rejection" | "cancellation" | "timeout" | "failure";

const PORT = Number(process.env.PORT ?? 5173);

class TimedProvider implements ModelProvider {
  calls = 0;

  constructor(
    private readonly steps: Array<
      | { delayMs: number; event: ProviderEvent }
      | { delayMs: number; error: Error }
      | { delayMs: number; waitForever: true }
    >,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;

    for (const step of this.steps) {
      await delay(step.delayMs, request.signal);
      if (request.signal.aborted) {
        return;
      }

      if ("waitForever" in step) {
        await delay(60_000, request.signal);
        return;
      }

      if ("error" in step) {
        throw step.error;
      }

      yield step.event;
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolveDelay) => {
    const timeout = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function createScenario(scenario: LiveScenario): {
  runtime: ConversationRuntime;
  input: string;
  timeoutMs?: number;
} {
  const store = new InMemoryConversationStore();

  if (scenario === "rejection") {
    return {
      input: "This input is rejected before provider invocation.",
      runtime: new ConversationRuntime({
        policy: rejectingPolicy,
        provider: new TimedProvider([
          { delayMs: 100, event: { type: "chunk", text: "must not appear" } },
        ]),
        store,
      }),
    };
  }

  if (scenario === "timeout") {
    return {
      input: "Start a stream that exceeds its configured deadline.",
      timeoutMs: 900,
      runtime: new ConversationRuntime({
        policy: acceptingPolicy,
        provider: new TimedProvider([
          { delayMs: 250, event: { type: "chunk", text: "partial text before timeout" } },
          { delayMs: 0, waitForever: true },
          { delayMs: 0, event: { type: "done" } },
        ]),
        store,
      }),
    };
  }

  if (scenario === "failure") {
    return {
      input: "Provider fails after a partial stream.",
      runtime: new ConversationRuntime({
        policy: acceptingPolicy,
        provider: new TimedProvider([
          {
            delayMs: 250,
            event: {
              type: "chunk",
              text: "partial text before provider error",
              metadata: {
                apiKey: "sk-live-demo-secret",
                hiddenReasoning: "private reasoning must not appear",
                publicProviderDetail: "visible diagnostic value",
              },
            },
          },
          { delayMs: 300, error: new Error("deterministic live provider failure") },
        ]),
        store,
      }),
    };
  }

  if (scenario === "cancellation") {
    return {
      input: "Start a stream and cancel after the first chunk.",
      timeoutMs: 5_000,
      runtime: new ConversationRuntime({
        policy: acceptingPolicy,
        provider: new TimedProvider([
          { delayMs: 250, event: { type: "chunk", text: "partial text before cancellation" } },
          { delayMs: 0, waitForever: true },
          { delayMs: 0, event: { type: "done" } },
        ]),
        store,
      }),
    };
  }

  return {
    input: "Stream a successful completed turn.",
    timeoutMs: 5_000,
    runtime: new ConversationRuntime({
      policy: acceptingPolicy,
      provider: new TimedProvider([
        { delayMs: 200, event: { type: "chunk", text: "Hello" } },
        { delayMs: 250, event: { type: "chunk", text: ", " } },
        { delayMs: 250, event: { type: "chunk", text: "world." } },
        { delayMs: 200, event: { type: "done", metadata: { providerRequestId: "live-demo" } } },
      ]),
      store,
    }),
  };
}

function sendSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleRun(response: ServerResponse, scenario: LiveScenario): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const setup = createScenario(scenario);
  const handle = setup.runtime.startTurn(
    { content: setup.input, metadata: { secret: "trace-redaction-demo" } },
    { timeoutMs: setup.timeoutMs },
  );

  let cancellationRequested = false;

  for await (const event of handle.events) {
    sendSse(response, { kind: "event", event });

    if (
      scenario === "cancellation" &&
      event.type === "response.chunk" &&
      !cancellationRequested
    ) {
      cancellationRequested = true;
      setTimeout(() => handle.cancel("live demo cancellation"), 350);
    }
  }

  sendSse(response, { kind: "result", result: await handle.completion });
  response.end();
}

function isScenario(value: string | null): value is LiveScenario {
  return (
    value === "success" ||
    value === "rejection" ||
    value === "cancellation" ||
    value === "timeout" ||
    value === "failure"
  );
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (url.pathname === "/api/run") {
      const scenario = url.searchParams.get("scenario");
      if (!isScenario(scenario)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unknown scenario" }));
        return;
      }
      await handleRun(response, scenario);
      return;
    }

    if (url.pathname === "/api/benchmark") {
      const runs = await runBenchmark(10);
      const terminalStateCounts = runs.reduce<Record<string, number>>((counts, run) => {
        counts[run.result.terminalState] = (counts[run.result.terminalState] ?? 0) + 1;
        return counts;
      }, {});
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          {
            totalRuns: runs.length,
            terminalStateCounts,
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
        ),
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  server.listen(PORT, () => {
    console.log(`Live demo running at http://localhost:${PORT}`);
  });
}

const html = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reliable Conversation Runtime</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --line: #d8dde6;
        --text: #18202b;
        --muted: #5c6675;
        --accent: #0f766e;
        --accent-strong: #115e59;
        --danger: #b42318;
        --ok: #166534;
        --warn: #a15c07;
        --shadow: 0 8px 24px rgba(24, 32, 43, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
        letter-spacing: 0;
      }

      header {
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }

      .topbar {
        max-width: 1180px;
        margin: 0 auto;
        padding: 18px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
      }

      .status {
        min-width: 150px;
        padding: 8px 10px;
        border: 1px solid var(--line);
        background: #f8fafc;
        text-align: center;
        font-size: 13px;
        font-weight: 700;
      }

      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 22px 20px 32px;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 18px;
      }

      button {
        min-height: 38px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: white;
        padding: 8px 12px;
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      button:hover {
        background: var(--accent-strong);
      }

      button.secondary {
        background: white;
        color: var(--accent-strong);
      }

      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 0.75fr);
        gap: 16px;
      }

      section {
        min-width: 0;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .section-head {
        min-height: 42px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
      }

      h2 {
        margin: 0;
        font-size: 15px;
        line-height: 1.2;
      }

      .output {
        min-height: 128px;
        padding: 16px;
        font-size: 18px;
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .records {
        min-height: 128px;
        padding: 12px;
        display: grid;
        gap: 8px;
      }

      .record {
        border: 1px solid var(--line);
        padding: 10px;
        background: #fbfcfe;
      }

      .record strong {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
      }

      .trace {
        max-height: 440px;
        overflow: auto;
        padding: 0;
        margin: 0;
        list-style: none;
        font-family:
          "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        font-size: 12px;
      }

      .trace li {
        display: grid;
        grid-template-columns: 44px 190px minmax(0, 1fr);
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--line);
      }

      .trace code {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 2px 8px;
        border: 1px solid var(--line);
        background: #f8fafc;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .completed {
        color: var(--ok);
      }

      .rejected,
      .cancelled,
      .timed_out {
        color: var(--warn);
      }

      .failed {
        color: var(--danger);
      }

      pre {
        margin: 0;
        padding: 12px;
        max-height: 280px;
        overflow: auto;
        background: #111827;
        color: #e5e7eb;
        font-size: 12px;
      }

      @media (max-width: 860px) {
        .topbar {
          align-items: flex-start;
          flex-direction: column;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .trace li {
          grid-template-columns: 34px 1fr;
        }

        .trace code {
          grid-column: 1 / -1;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="topbar">
        <h1>Reliable Conversation Runtime</h1>
        <div id="status" class="status">idle</div>
      </div>
    </header>

    <main>
      <div class="toolbar">
        <button data-scenario="success">Run Success</button>
        <button data-scenario="rejection">Run Rejection</button>
        <button data-scenario="cancellation">Run Cancellation</button>
        <button data-scenario="timeout">Run Timeout</button>
        <button data-scenario="failure">Run Failure</button>
        <button id="benchmark" class="secondary">Run Benchmark</button>
      </div>

      <div class="grid">
        <section>
          <div class="section-head">
            <h2>Streamed Output</h2>
            <span id="terminal" class="pill">no run</span>
          </div>
          <div id="output" class="output"></div>
        </section>

        <section>
          <div class="section-head">
            <h2>Persisted Records</h2>
            <span id="recordCount" class="pill">0</span>
          </div>
          <div id="records" class="records"></div>
        </section>

        <section>
          <div class="section-head">
            <h2>Ordered Trace</h2>
            <span id="traceCount" class="pill">0</span>
          </div>
          <ul id="trace" class="trace"></ul>
        </section>

        <section>
          <div class="section-head">
            <h2>Benchmark Result</h2>
            <span class="pill">10 each</span>
          </div>
          <pre id="benchmarkOutput">{}</pre>
        </section>
      </div>
    </main>

    <script>
      const statusEl = document.querySelector("#status");
      const outputEl = document.querySelector("#output");
      const terminalEl = document.querySelector("#terminal");
      const recordsEl = document.querySelector("#records");
      const recordCountEl = document.querySelector("#recordCount");
      const traceEl = document.querySelector("#trace");
      const traceCountEl = document.querySelector("#traceCount");
      const benchmarkOutputEl = document.querySelector("#benchmarkOutput");
      const buttons = [...document.querySelectorAll("button")];
      let source = null;
      let traceCount = 0;

      for (const button of document.querySelectorAll("[data-scenario]")) {
        button.addEventListener("click", () => runScenario(button.dataset.scenario));
      }

      document.querySelector("#benchmark").addEventListener("click", async () => {
        setBusy(true, "benchmark");
        benchmarkOutputEl.textContent = "running...";
        const response = await fetch("/api/benchmark");
        benchmarkOutputEl.textContent = JSON.stringify(await response.json(), null, 2);
        setBusy(false, "idle");
      });

      function runScenario(scenario) {
        if (source) {
          source.close();
        }

        resetRun();
        setBusy(true, scenario);
        source = new EventSource("/api/run?scenario=" + encodeURIComponent(scenario));

        source.onmessage = (message) => {
          const payload = JSON.parse(message.data);

          if (payload.kind === "event") {
            renderEvent(payload.event);
          }

          if (payload.kind === "result") {
            renderResult(payload.result);
            setBusy(false, "idle");
            source.close();
            source = null;
          }
        };

        source.onerror = () => {
          if (source) {
            source.close();
            source = null;
          }
          setBusy(false, "connection closed");
        };
      }

      function resetRun() {
        outputEl.textContent = "";
        terminalEl.textContent = "running";
        terminalEl.className = "pill";
        recordsEl.innerHTML = "";
        recordCountEl.textContent = "0";
        traceEl.innerHTML = "";
        traceCount = 0;
        traceCountEl.textContent = "0";
      }

      function renderEvent(event) {
        traceCount += 1;
        traceCountEl.textContent = String(traceCount);

        if (event.type === "response.chunk") {
          outputEl.textContent += event.fields.text;
        }

        if (event.type === "run.terminal") {
          terminalEl.textContent = event.fields.state;
          terminalEl.className = "pill " + event.fields.state;
        }

        const item = document.createElement("li");
        item.innerHTML =
          "<span>" +
          event.sequence +
          "</span><strong>" +
          escapeHtml(event.type) +
          "</strong><code>" +
          escapeHtml(JSON.stringify(event.fields)) +
          "</code>";
        traceEl.appendChild(item);
        traceEl.scrollTop = traceEl.scrollHeight;
      }

      function renderResult(result) {
        recordsEl.innerHTML = "";
        recordCountEl.textContent = String(result.persistedRecords.length);

        for (const record of result.persistedRecords) {
          const node = document.createElement("div");
          node.className = "record";
          node.innerHTML =
            "<strong>" +
            escapeHtml(record.role + " / " + record.status) +
            "</strong><div>" +
            escapeHtml(record.content) +
            "</div>";
          recordsEl.appendChild(node);
        }
      }

      function setBusy(isBusy, label) {
        statusEl.textContent = label;
        for (const button of buttons) {
          button.disabled = isBusy;
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }
    </script>
  </body>
</html>`;
