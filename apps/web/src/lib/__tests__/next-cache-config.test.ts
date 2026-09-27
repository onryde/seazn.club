// apps/web/src/lib/__tests__/next-cache-config.test.ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { normalizeConfig } from "next/dist/server/config-shared";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/dist/shared/lib/constants";
import loadedByNext, { nextConfig } from "../../../next.config.js";

function expectWired(cfg: { cacheHandler?: string; cacheMaxMemorySize?: number }) {
  expect(cfg.cacheHandler).toMatch(/cache-handler\/handler\.mjs$/);
  expect(existsSync(cfg.cacheHandler!)).toBe(true);
  expect(cfg.cacheMaxMemorySize).toBe(0);
}

describe("next.config wires the shared cache handler", () => {
  it("points cacheHandler at an existing handler file and disables Next's own memory cache", () => {
    expectWired(nextConfig);
  });

  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])(
    "the default export (withSentryConfig's result), resolved as Next resolves it in %s, keeps that wiring",
    async (phase) => {
      // normalizeConfig is Next's own step from the loaded default export to a
      // config object: it calls a config function and awaits a promise.
      expectWired(await normalizeConfig(phase, loadedByNext));
    },
  );
});
