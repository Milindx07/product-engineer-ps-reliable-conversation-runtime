import type {
  ModelProvider,
  Policy,
  PolicyDecision,
  ProviderEvent,
  ProviderRequest,
  TurnInput,
} from "./domain.js";

export class StaticPolicy implements Policy {
  constructor(private readonly decision: PolicyDecision) {}

  async evaluate(_input: TurnInput): Promise<PolicyDecision> {
    return this.decision;
  }
}

export const acceptingPolicy = new StaticPolicy({
  allowed: true,
  code: "policy_allowed",
  reason: "Accepted by deterministic fake policy.",
});

export const rejectingPolicy = new StaticPolicy({
  allowed: false,
  code: "policy_rejected",
  reason: "Rejected by deterministic fake policy.",
});

export type ScriptedProviderStep =
  | ProviderEvent
  | {
      type: "fail";
      error: Error;
    }
  | {
      type: "wait";
      gate: Gate;
    };

export class ScriptedProvider implements ModelProvider {
  calls = 0;
  consumedSteps = 0;

  constructor(private readonly steps: ScriptedProviderStep[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;

    for (const step of this.steps) {
      if (request.signal.aborted) {
        return;
      }

      if (step.type === "wait") {
        await step.gate.wait(request.signal);
        continue;
      }

      this.consumedSteps += 1;

      if (step.type === "fail") {
        throw step.error;
      }

      yield step;
    }
  }
}

export class Gate {
  private opened = false;
  private resolveWaiters: Array<() => void> = [];

  open(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    for (const resolve of this.resolveWaiters.splice(0)) {
      resolve();
    }
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.opened || signal?.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.resolveWaiters.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

export async function collectEvents(
  events: AsyncIterable<unknown>,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export function hasCompletedAssistantResponse(records: Array<{ status: string }>): boolean {
  return records.some((record) => record.status === "completed_assistant_response");
}
