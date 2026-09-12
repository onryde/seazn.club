// Pin live Cache-Control so PUBLIC_CACHE_CONTROL cannot silently return.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("live public fixture Cache-Control", () => {
  it("overlay route uses private, no-store", () => {
    const src = readFileSync(
      new URL("../overlay/route.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/LIVE_CACHE_CONTROL\s*=\s*"private, no-store"/);
    expect(src).toMatch(/"Cache-Control": LIVE_CACHE_CONTROL/);
    expect(src).not.toMatch(/"Cache-Control": PUBLIC_CACHE_CONTROL/);
  });

  it("fixture summary route uses private, no-store", () => {
    const src = readFileSync(new URL("../route.ts", import.meta.url), "utf8");
    expect(src).toMatch(/LIVE_CACHE_CONTROL\s*=\s*"private, no-store"/);
    expect(src).toMatch(/"Cache-Control": LIVE_CACHE_CONTROL/);
    expect(src).not.toMatch(/"Cache-Control": PUBLIC_CACHE_CONTROL/);
  });
});
