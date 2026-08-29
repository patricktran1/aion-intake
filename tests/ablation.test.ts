import { afterEach, describe, expect, it } from "vitest";
import { isModelEnabled, isStageEnabled, modelMode } from "@/lib/ai/client";

/**
 * The ablation switch decides which model stages run. It is test
 * infrastructure, so it has to be trustworthy: a mode that silently fails to
 * disable a stage would make every ablation number a lie, and a typo that
 * silently disabled a stage in production would remove a safety path.
 */

const KEY = process.env.ANTHROPIC_API_KEY;
const MODE = process.env.AION_MODEL_MODE;

afterEach(() => {
  if (KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = KEY;
  if (MODE === undefined) delete process.env.AION_MODEL_MODE;
  else process.env.AION_MODEL_MODE = MODE;
});

const withEnv = (key: string | undefined, mode: string | undefined) => {
  if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  if (mode === undefined) delete process.env.AION_MODEL_MODE;
  else process.env.AION_MODEL_MODE = mode;
};

describe("model ablation modes", () => {
  it("no key means no stage runs, whatever the mode says", () => {
    for (const mode of ["off", "facts", "turn", "hpi", "full", undefined]) {
      withEnv(undefined, mode);
      expect(isModelEnabled()).toBe(false);
      expect(isStageEnabled("turn")).toBe(false);
      expect(isStageEnabled("question")).toBe(false);
      expect(isStageEnabled("hpi")).toBe(false);
    }
  });

  it.each([
    ["off", { turn: false, question: false, hpi: false }],
    ["facts", { turn: true, question: false, hpi: false }],
    ["turn", { turn: true, question: true, hpi: false }],
    ["hpi", { turn: false, question: false, hpi: true }],
    ["full", { turn: true, question: true, hpi: true }],
  ] as const)("mode %s gates exactly the stages it names", (mode, want) => {
    withEnv("sk-test", mode);
    expect(isStageEnabled("turn")).toBe(want.turn);
    expect(isStageEnabled("question")).toBe(want.question);
    expect(isStageEnabled("hpi")).toBe(want.hpi);
  });

  it("defaults to full, and an unrecognised mode degrades to full rather than off", () => {
    withEnv("sk-test", undefined);
    expect(modelMode()).toBe("full");
    withEnv("sk-test", "ful");
    expect(modelMode()).toBe("full");
    expect(isStageEnabled("hpi")).toBe(true);
    withEnv("sk-test", "OFF");
    expect(modelMode()).toBe("off");
  });

  it("off is indistinguishable from having no key at all", () => {
    withEnv("sk-test", "off");
    expect(isModelEnabled()).toBe(false);
    const withKeyOff = ["turn", "question", "hpi"].map((s) =>
      isStageEnabled(s as "turn" | "question" | "hpi"),
    );
    withEnv(undefined, "full");
    const noKey = ["turn", "question", "hpi"].map((s) =>
      isStageEnabled(s as "turn" | "question" | "hpi"),
    );
    expect(withKeyOff).toEqual(noKey);
  });
});
