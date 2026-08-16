import { describe, it, expect } from "vitest";
import { applyPolicy, ALLOWED_PROVIDERS, PARSE_ALLOWED_PROVIDERS } from "../openrouter-policy";

describe("openrouter data policy", () => {
  it("denies data collection and pins zero retention", () => {
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.data_collection).toBe("deny");
    expect(body.zdr).toBe(true);
  });

  it("restricts routing to the allowlist and forbids fallbacks", () => {
    // allow_fallbacks defaults true upstream; without this, routing can leave
    // the allowlist and the customer promise silently stops holding.
    const body = applyPolicy({ model: "vendor/model" });
    expect(body.provider.only).toEqual(ALLOWED_PROVIDERS);
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it("cannot be overridden by the caller", () => {
    const body = applyPolicy({
      model: "vendor/model",
      provider: { data_collection: "allow", allow_fallbacks: true },
      zdr: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(body.provider.data_collection).toBe("deny");
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.zdr).toBe(true);
  });

  it("keeps a non-empty allowlist", () => {
    expect(ALLOWED_PROVIDERS.length).toBeGreaterThan(0);
  });
});

describe("parse-path allowlist", () => {
  it("leaves the paid-path allowlist exactly as narrowed on 2026-07-21", () => {
    // The regression that matters. The parse bench needed reseller slugs, and
    // the cheap way to get them is to widen the shared list — which would move
    // architect and officials traffic to vendors the help pages do not name.
    // This asserts the shared list did NOT move.
    expect(ALLOWED_PROVIDERS).toEqual(["xai", "google-vertex"]);
  });

  it("adds only structured-output-capable slugs for the parse pre-flight", () => {
    // Verified live 2026-08-15 against /models/{id}/endpoints: a model id names
    // who BUILT a model, never who SERVES it. z-ai/glm-4.7-flash is served by
    // deepinfra/venice/cloudflare/novita and NOT by `z-ai`; nvidia/nemotron-*
    // by deepinfra/coreweave/venice and NOT by `nvidia`. Slugs come from the
    // endpoint `tag` up to the first "/", same standard as ALLOWED_PROVIDERS.
    expect(PARSE_ALLOWED_PROVIDERS).toEqual(["google-vertex", "xai", "deepinfra", "akashml"]);
  });

  it("carries the same data guarantees as the paid path", () => {
    const body = applyPolicy({ model: "vendor/model" }, PARSE_ALLOWED_PROVIDERS);
    expect(body.provider.only).toEqual(PARSE_ALLOWED_PROVIDERS);
    expect(body.provider.data_collection).toBe("deny");
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.zdr).toBe(true);
  });

  it("still defaults to the paid-path allowlist when no list is passed", () => {
    expect(applyPolicy({ model: "vendor/model" }).provider.only).toEqual(ALLOWED_PROVIDERS);
  });
});
