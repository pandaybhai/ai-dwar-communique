import { describe, expect, it } from "vitest";
import { decideEscalation } from "@/lib/ai-run.server";

const base = {
  answer: "It is ₹649 and burns for about 40 hours.",
  knowledgeMatched: true,
  toolUsed: false,
  toolsBrokered: true,
  anyToolFailed: false,
  history: [],
  merchantRules: "",
};

describe("decideEscalation hand-over rules", () => {
  it("does not hold a known price question when only platform wording mentions a price", () => {
    // The assembled brief (platform wording) must never reach this check.
    expect(
      decideEscalation({ ...base, question: "What is the price of the lavender candle?" }),
    ).toBeNull();
  });

  it("still triggers on a genuine merchant-authored hand-over rule", () => {
    expect(
      decideEscalation({
        ...base,
        question: "Can I get a wholesale order of 200 candles?",
        merchantRules: "wholesale\nbulk order",
      }),
    ).toBe("merchant_rule");
  });

  it("still hands over when the customer asks for a person", () => {
    expect(
      decideEscalation({ ...base, question: "Can I speak to a human please?" }),
    ).toBe("customer_frustrated");
  });

  it("still hands over an unknown discount with no source", () => {
    expect(
      decideEscalation({
        ...base,
        question: "How much discount do I get on a bulk order?",
        answer: "I will check with the owner.",
        knowledgeMatched: false,
      }),
    ).toBe("no_source");
  });
});
