export type RunId = string;

export type TerminalState =
  | "completed"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "failed";

export type RuntimeState =
  | "created"
  | "policy_checking"
  | "policy_accepted"
  | "streaming"
  | TerminalState;

export interface TurnInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  code: string;
  reason: string;
  trace?: Record<string, unknown>;
}

export interface Policy {
  evaluate(input: TurnInput): Promise<PolicyDecision>;
}

export type ProviderEvent =
  | {
      type: "chunk";
      text: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "done";
      metadata?: Record<string, unknown>;
    };

export interface ProviderRequest {
  runId: RunId;
  input: TurnInput;
  signal: AbortSignal;
}

export interface ModelProvider {
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface OperationalEvent {
  sequence: number;
  timestamp: string;
  runId: RunId;
  type: string;
  fields: Record<string, unknown>;
}

export type ConversationRecordStatus =
  | "accepted_user_input"
  | "completed_assistant_response";

export interface ConversationRecord {
  id: string;
  runId: RunId;
  role: "user" | "assistant";
  content: string;
  status: ConversationRecordStatus;
  committedAtSequence: number;
}

export interface TransitionRejection {
  attempted: TerminalState;
  winner: TerminalState;
  reason: string;
}

export interface RunResult {
  runId: RunId;
  terminalState: TerminalState;
  chunks: string[];
  partialOutput: string;
  providerInvoked: boolean;
  trace: OperationalEvent[];
  persistedRecords: ConversationRecord[];
  transitionRejections: TransitionRejection[];
}

export interface TurnHandle {
  runId: RunId;
  events: AsyncIterable<OperationalEvent>;
  completion: Promise<RunResult>;
  cancel(reason?: string): boolean;
}

export interface SchedulerHandle {
  readonly id: number;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): SchedulerHandle;
  clearTimeout(handle: SchedulerHandle): void;
}
