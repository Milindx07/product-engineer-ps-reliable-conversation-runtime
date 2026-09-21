import type { Policy, PolicyDecision, TurnInput } from "./domain.js";

export class KeywordPolicy implements Policy {
  constructor(private readonly rejectedTerms: string[] = ["blocked", "disallowed"]) {}

  async evaluate(input: TurnInput): Promise<PolicyDecision> {
    const normalized = input.content.toLowerCase();
    const rejectedTerm = this.rejectedTerms.find((term) =>
      normalized.includes(term.toLowerCase()),
    );

    if (rejectedTerm) {
      return {
        allowed: false,
        code: "policy_rejected_keyword",
        reason: `Input matched rejected policy term: ${rejectedTerm}`,
        trace: { rejectedTerm },
      };
    }

    return {
      allowed: true,
      code: "policy_allowed",
      reason: "Input passed deterministic keyword policy.",
    };
  }
}
