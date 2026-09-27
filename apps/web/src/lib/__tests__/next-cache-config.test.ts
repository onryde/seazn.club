// apps/web/src/lib/__tests__/next-cache-config.test.ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { nextConfig } from "../../../next.config.js";

describe("next.config wires the shared cache handler", () => {
  it("points cacheHandler at an existing handler file and disables Next's own memory cache", () => {
    expect(nextConfig.cacheHandler).toMatch(/cache-handler\/handler\.mjs$/);
    expect(existsSync(nextConfig.cacheHandler!)).toBe(true);
    expect(nextConfig.cacheMaxMemorySize).toBe(0);
  });
});
