// Memory usage (next docs: guides/memory-usage, "Preloading Entries"). The
// server otherwise loads every page's JS into memory at boot; measured on a
// production build (3 runs each, `next start`, 20 public/marketing URLs):
// idle RSS 266/262/271 MB -> 145/145/143 MB with preloading off, and the same
// ~400 MB after the pages are requested (modules are never unloaded, so the
// steady state converges). The Fly VMs are 1 GB and suspend/resume.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "next/dist/server/config-shared";
import { nextConfig } from "../../../next.config.js";

describe("next.config memory settings", () => {
  it("does not preload every page entry at server start", () => {
    // premise: Next's own default is to preload (the flag is a real opt-out)
    expect(defaultConfig.experimental.preloadEntriesOnStart, "premise: default preloads").toBe(true);
    expect((nextConfig as { experimental?: { preloadEntriesOnStart?: boolean } }).experimental?.preloadEntriesOnStart).toBe(false);
  });
});
