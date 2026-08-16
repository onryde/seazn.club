// Which model the pre-flight actually asks for, and what happens on a
// deployment that cannot reach it.
//
// The parse bench (2026-08-16, 35 cases x 5 arms) put google/gemini-3.7-flash
// ahead of the shipped claude-haiku-4-5 on the only metric that matters here:
// it invented ZERO constraints where haiku invented five, while also scoring
// 32/35 against 30/35 and costing 2.7x less. So it becomes the default.
//
// The hazard that makes this more than a string change: gemini is an OpenRouter
// slug, and `parseInstruction` refuses BEFORE calling when the provider is
// unconfigured — returning {raw:null, failed:true}, which the run treats as "no
// compiled rules" and never surfaces as an error. On a deployment holding only
// ANTHROPIC_API_KEY, a bare flip would therefore silently discard every
// organiser's brief, with nothing in the logs to say why. The default has to
// degrade to the Anthropic model instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PARSE_MODEL, PARSE_MODEL_FALLBACK, parseInstruction, parserAiModel } from "../schedule-ai-parse";
import type { AiProvider } from "@/server/ai/provider";

const { resolveProviderMock } = vi.hoisted(() => ({ resolveProviderMock: vi.fn() }));
vi.mock("@/server/ai/select-provider", () => ({
  resolveProvider: resolveProviderMock,
  selectProvider: () => resolveProviderMock("anthropic"),
}));

const CTX = { divisions: [{ id: "d1", name: "Open Singles" }] };
const OUT = { hard: [], soft: [], unparsed: [] };

// `AiProvider.chat` is generic in the schema's output type, which a plain
// vi.fn() cannot express — hence the cast. The mock itself is returned
// alongside so call assertions stay type-safe.
const stub = () => {
  const chat = vi.fn(async () => ({
    parsed: OUT,
    assistantTurn: { role: "assistant" as const, content: {} },
    usage: { inputTokens: 10, outputTokens: 10, costUsd: null },
    servedModel: "x",
    refused: false,
  }));
  const provider = {
    id: "anthropic" as const,
    isConfigured: () => true,
    chat,
  } as unknown as AiProvider;
  return Object.assign(provider, { chat });
};

let savedKey: string | undefined;
let savedPin: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  savedPin = process.env.SCHEDULING_PARSE_MODEL;
  delete process.env.SCHEDULING_PARSE_MODEL;
  resolveProviderMock.mockReturnValue(stub());
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  if (savedPin === undefined) delete process.env.SCHEDULING_PARSE_MODEL;
  else process.env.SCHEDULING_PARSE_MODEL = savedPin;
  resolveProviderMock.mockReset();
});

describe("parserAiModel", () => {
  it("asks for gemini-3.7-flash where OpenRouter is configured", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    expect(parserAiModel()).toBe(PARSE_MODEL);
    expect(PARSE_MODEL).toBe("google/gemini-3.7-flash");
  });

  it("degrades to the Anthropic model where it is not", () => {
    // NOT a silent dead parse. This is the whole point of the fallback.
    delete process.env.OPENROUTER_API_KEY;
    expect(parserAiModel()).toBe(PARSE_MODEL_FALLBACK);
    expect(PARSE_MODEL_FALLBACK).not.toContain("/");
  });

  it("lets SCHEDULING_PARSE_MODEL pin either way", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.SCHEDULING_PARSE_MODEL = "claude-haiku-4-5-20251001";
    expect(parserAiModel()).toBe("claude-haiku-4-5-20251001");

    delete process.env.OPENROUTER_API_KEY;
    process.env.SCHEDULING_PARSE_MODEL = "z-ai/glm-4.7-flash";
    expect(parserAiModel()).toBe("z-ai/glm-4.7-flash");
  });
});

describe("provider still follows the model slug, never AI_PROVIDER", () => {
  it("routes the OpenRouter default to openrouter", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.AI_PROVIDER = "anthropic";
    await parseInstruction("final on friday", CTX);
    expect(resolveProviderMock).toHaveBeenCalledWith("openrouter");
  });

  it("routes the fallback to anthropic", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_PROVIDER = "openrouter";
    await parseInstruction("final on friday", CTX);
    expect(resolveProviderMock).toHaveBeenCalledWith("anthropic");
  });

  it("still lets an explicit opts.model win outright", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const provider = stub();
    await parseInstruction("final on friday", CTX, {
      provider,
      model: "claude-haiku-4-5-20251001",
    });
    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    );
  });
});
