import type { ConversationRecord, RunId } from "./domain.js";

export interface ConversationStore {
  appendUserInput(args: {
    runId: RunId;
    content: string;
    committedAtSequence: number;
  }): ConversationRecord;
  appendCompletedAssistantResponse(args: {
    runId: RunId;
    content: string;
    committedAtSequence: number;
  }): ConversationRecord;
  recordsForRun(runId: RunId): ConversationRecord[];
  allRecords(): ConversationRecord[];
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly records: ConversationRecord[] = [];
  private nextRecordId = 1;

  appendUserInput(args: {
    runId: RunId;
    content: string;
    committedAtSequence: number;
  }): ConversationRecord {
    return this.append({
      runId: args.runId,
      role: "user",
      content: args.content,
      status: "accepted_user_input",
      committedAtSequence: args.committedAtSequence,
    });
  }

  appendCompletedAssistantResponse(args: {
    runId: RunId;
    content: string;
    committedAtSequence: number;
  }): ConversationRecord {
    return this.append({
      runId: args.runId,
      role: "assistant",
      content: args.content,
      status: "completed_assistant_response",
      committedAtSequence: args.committedAtSequence,
    });
  }

  recordsForRun(runId: RunId): ConversationRecord[] {
    return this.records.filter((record) => record.runId === runId);
  }

  allRecords(): ConversationRecord[] {
    return [...this.records];
  }

  private append(record: Omit<ConversationRecord, "id">): ConversationRecord {
    const persisted = {
      id: `rec_${this.nextRecordId++}`,
      ...record,
    };
    this.records.push(persisted);
    return persisted;
  }
}
