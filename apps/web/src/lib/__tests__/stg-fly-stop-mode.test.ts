import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Staging's web machines STOP when idle; they never SUSPEND (owner, 2026-10-14).
//
// A suspended Fly VM resumes with its monotonic clock paused for the whole
// suspension, and Next ages its data cache and ISR entries by
// `performance.timeOrigin + performance.now()` while stamping them with the wall
// clock. Every cached entry therefore stayed "fresh" for 30 s PLUS all the
// suspended time — measured on stg as a public fixture page that served a cached
// 404 for ~32 minutes against a 30 s revalidate. A stopped machine cold-boots
// with a fresh process, so no entry outlives its window.
//
// Production (fly.toml) still suspends: the owner ruled "stg first", so this pins
// staging only. Moving prod is its own change.
function repoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (!existsSync(join(dir, "fly.stg.toml"))) {
    const up = resolve(dir, "..");
    if (up === dir) throw new Error("fly.stg.toml not found above the test file");
    dir = up;
  }
  return dir;
}

describe("staging idle machines", () => {
  const toml = readFileSync(join(repoRoot(), "fly.stg.toml"), "utf8");
  const settings = [...toml.matchAll(/^\s*auto_stop_machines\s*=\s*"([^"]*)"/gm)].map((m) => m[1]);

  it("stop rather than suspend, so the Next cache clock never pauses", () => {
    // One setting, read from the file — zero would mean the key moved and this
    // test would pass on nothing.
    expect(settings).toHaveLength(1);
    expect(settings[0]).toBe("stop");
  });
});
