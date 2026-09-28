import { describe, expect, it } from "vitest";
import { isQuestionText, isTeachableAnswer } from "./teach-guard";

describe("owner reply: question or answer", () => {
  it.each(["What is the delivery time", "kya COD hai", "tell me the price", "Batao timing", "We deliver in 3 days?"])(
    "question: %s",
    (t) => expect(isQuestionText(t)).toBe(true),
  );
  it.each([
    "Do not ship on Sundays",
    "Is available in all sizes, yes",
    "Can deliver in 2 days within Mumbai",
    "Yes? No, we deliver pan-India in 5 days",
  ])("answer: %s", (t) => {
    expect(isQuestionText(t)).toBe(false);
    expect(isTeachableAnswer(t)).toBe(true);
  });
});
