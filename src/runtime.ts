import { createHash } from "node:crypto";
import { AsyncQueue } from "./async-queue.js";
import type {
  ModelProvider,
  OperationalEvent,
  Policy,
  ProviderEvent,
  RunId,
  RunResult,
  Scheduler,
  SchedulerHandle,
  TerminalState,
  TransitionRejection,
  TurnHandle,
  TurnInput,
} from "./domain.js";
import type { ConversationStore } from "./persistence.js";
import { RealScheduler } from "./scheduler.js";
import { TraceRecorder } from "./trace.js";

export interface ConversationRuntimeOptions {
  policy: Policy;
  provider: ModelProvider;
  store: ConversationStore;
  scheduler?: Scheduler;
  idFactory?: () => RunId;
}

export interface StartTurnOptions {
  timeoutMs?: number;
}

export class ConversationRuntime {
  private nextRunNumber = 1;
  private readonly scheduler: Scheduler;
  private readonly idFactory: () => RunId;

  constructor(private readonly options: ConversationRuntimeOptions) {
    this.scheduler = options.scheduler ?? new RealScheduler();
    this.idFactory =
      options.idFactory ?? (() => `run_${String(this.nextRunNumber++).padStart(4, "0")}`);
  }

  startTurn(input: TurnInput, options: StartTurnOptions = {}): TurnHandle {
    const runId = this.idFactory();
    const queue = new AsyncQueue<OperationalEvent>();
    const recorder = new TraceRecorder(runId, (event) => queue.push(event));
    const abortController = new AbortController();
    const chunks: string[] = [];
    const transitionRejections: TransitionRejection[] = [];
    let terminalState: TerminalState | undefined;
    let providerInvoked = false;
    let timeoutHandle: SchedulerHandle | undefined;
    let resolveCompletion!: (result: RunResult) => void;

    const completion = new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const buildResult = (): RunResult => ({
      runId,
      terminalState: terminalState ?? "failed",
      chunks: [...chunks],
      partialOutput: chunks.join(""),
      providerInvoked,
      trace: recorder.snapshot(),
      persistedRecords: this.options.store.recordsForRun(runId),
      transitionRejections,
    });

    const finish = (
      attempted: TerminalState,
      fields: Record<string, unknown> = {},
    ): boolean => {
      if (terminalState) {
        transitionRejections.push({
          attempted,
          winner: terminalState,
          reason: "run already reached a terminal state",
        });
        return false;
      }

      terminalState = attempted;
      if (timeoutHandle) {
        this.scheduler.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (!abortController.signal.aborted) {
        abortController.abort(attempted);
      }
      recorder.record("run.terminal", { state: attempted, ...fields });
      queue.close();
      resolveCompletion(buildResult());
      return true;
    };

    const cancel = (reason = "caller requested cancellation"): boolean => {
      if (terminalState) {
        return finish("cancelled", { reason });
      }
      recorder.record("cancellation.requested", { reason });
      return finish("cancelled", { reason });
    };

    if (options.timeoutMs !== undefined) {
      timeoutHandle = this.scheduler.setTimeout(() => {
        if (terminalState) {
          finish("timed_out", { timeoutMs: options.timeoutMs });
          return;
        }
        recorder.record("deadline.reached", { timeoutMs: options.timeoutMs });
        finish("timed_out", { timeoutMs: options.timeoutMs });
      }, options.timeoutMs);
    }

    void this.run({
      input,
      runId,
      recorder,
      signal: abortController.signal,
      chunks,
      setProviderInvoked: () => {
        providerInvoked = true;
      },
      isTerminal: () => terminalState !== undefined,
      finish,
    });

    return {
      runId,
      events: queue,
      completion,
      cancel,
    };
  }

  private async run(args: {
    input: TurnInput;
    runId: RunId;
    recorder: TraceRecorder;
    signal: AbortSignal;
    chunks: string[];
    setProviderInvoked: () => void;
    isTerminal: () => boolean;
    finish: (state: TerminalState, fields?: Record<string, unknown>) => boolean;
  }): Promise<void> {
    const inputHash = createHash("sha256").update(args.input.content).digest("hex");

    try {
      args.recorder.record("run.started", {
        inputLength: args.input.content.length,
        inputSha256: inputHash,
        metadata: args.input.metadata ?? {},
      });

      args.recorder.record("policy.started");
      const policyDecision = await this.options.policy.evaluate(args.input);

      if (args.isTerminal()) {
        return;
      }

      args.recorder.record("policy.decision", {
        allowed: policyDecision.allowed,
        code: policyDecision.code,
        reason: policyDecision.reason,
        trace: policyDecision.trace ?? {},
      });

      if (!policyDecision.allowed) {
        args.finish("rejected", {
          code: policyDecision.code,
          reason: policyDecision.reason,
        });
        return;
      }

      this.options.store.appendUserInput({
        runId: args.runId,
        content: args.input.content,
        committedAtSequence: args.recorder.nextSequence(),
      });
      args.recorder.record("persistence.user_committed", {
        status: "accepted_user_input",
      });

      if (args.isTerminal()) {
        return;
      }

      args.setProviderInvoked();
      args.recorder.record("provider.started");

      for await (const providerEvent of this.options.provider.stream({
        runId: args.runId,
        input: args.input,
        signal: args.signal,
      })) {
        if (args.isTerminal()) {
          break;
        }

        const validationError = validateProviderEvent(providerEvent);
        if (validationError) {
          args.recorder.record("provider.error", {
            message: validationError,
          });
          args.finish("failed", { reason: validationError });
          return;
        }

        if (providerEvent.type === "chunk") {
          args.chunks.push(providerEvent.text);
          args.recorder.record("response.chunk", {
            index: args.chunks.length - 1,
            text: providerEvent.text,
            metadata: providerEvent.metadata ?? {},
          });
          continue;
        }

        args.recorder.record("provider.done", {
          metadata: providerEvent.metadata ?? {},
        });

        this.options.store.appendCompletedAssistantResponse({
          runId: args.runId,
          content: args.chunks.join(""),
          committedAtSequence: args.recorder.nextSequence(),
        });
        args.recorder.record("persistence.assistant_committed", {
          status: "completed_assistant_response",
        });
        args.finish("completed");
        return;
      }

      if (!args.isTerminal()) {
        args.recorder.record("provider.error", {
          message: "provider stream ended without a done event",
        });
        args.finish("failed", {
          reason: "provider stream ended without a done event",
        });
      }
    } catch (error) {
      if (args.isTerminal()) {
        return;
      }

      args.recorder.record("provider.error", {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "UnknownError",
      });
      args.finish("failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function validateProviderEvent(event: ProviderEvent): string | undefined {
  if (!event || typeof event !== "object") {
    return "provider emitted a non-object event";
  }

  if (event.type === "chunk") {
    return typeof event.text === "string"
      ? undefined
      : "provider chunk event did not include string text";
  }

  if (event.type === "done") {
    return undefined;
  }

  return "provider emitted an unknown event type";
}
