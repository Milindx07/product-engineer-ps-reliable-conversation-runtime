import type { OperationalEvent, RunId } from "./domain.js";

const SENSITIVE_KEY_PATTERN =
  /secret|token|api[-_]?key|authorization|password|hiddenreasoning|chainofthought|\bcot\b/i;

export function sanitizeForTrace(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForTrace(item));
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeForTrace(nested);
    }
    return sanitized;
  }

  return value;
}

export class TraceRecorder {
  private sequence = 0;
  private readonly events: OperationalEvent[] = [];

  constructor(
    private readonly runId: RunId,
    private readonly onEvent: (event: OperationalEvent) => void,
  ) {}

  record(type: string, fields: Record<string, unknown> = {}): OperationalEvent {
    const event: OperationalEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      type,
      fields: sanitizeForTrace(fields) as Record<string, unknown>,
    };

    this.events.push(event);
    this.onEvent(event);
    return event;
  }

  nextSequence(): number {
    return this.sequence + 1;
  }

  snapshot(): OperationalEvent[] {
    return [...this.events];
  }
}
