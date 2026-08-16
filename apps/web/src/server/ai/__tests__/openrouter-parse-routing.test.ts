// The wire-level half of the parse-path allowlist: a request marked
// `routing: "parse"` must carry the parse list, and every other request must
// still carry the narrowed paid-path list.
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { buildOpenRouterBody } from "../openrouter-request";
import { ALLOWED_PROVIDERS, PARSE_ALLOWED_PROVIDERS } from "../openrouter-policy";
import type { AiChatRequest } from "../provider";

const req = (routing?: "parse"): AiChatRequest<{ ok: boolean }> => ({
  model: "z-ai/glm-4.7-flash",
  system: "compile the instruction",
  messages: [{ role: "user", content: "{}" }],
  maxTokens: 1_000,
  reasoning: { kind: "none" },
  schema: { name: "instruction_constraints", zod: z.object({ ok: z.boolean() }) },
  signal: new AbortController().signal,
  timeoutMs: 60_000,
  ...(routing ? { routing } : {}),
});

type Body = { provider: { only: readonly string[]; allow_fallbacks: boolean; data_collection: string } };

describe("buildOpenRouterBody routing", () => {
  it("routes an unmarked request on the paid-path allowlist", () => {
    const body = buildOpenRouterBody(req()) as unknown as Body;
    expect(body.provider.only).toEqual(ALLOWED_PROVIDERS);
  });

  it("routes a parse request on the parse allowlist", () => {
    const body = buildOpenRouterBody(req("parse")) as unknown as Body;
    expect(body.provider.only).toEqual(PARSE_ALLOWED_PROVIDERS);
  });

  it("keeps the data guarantees on the parse route", () => {
    // Widening WHO may serve must never widen WHAT they may do with it.
    const body = buildOpenRouterBody(req("parse")) as unknown as Body;
    expect(body.provider.data_collection).toBe("deny");
    expect(body.provider.allow_fallbacks).toBe(false);
  });
});
