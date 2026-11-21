// Task 21: vitest.config.ts loads the developer's .env.local, which holds a real Bunny key. The config drops the outbound
// credentials the file brought in (never one exported by hand, so the gated live probe still gets its shell values). The drop
// runs at config load, before any test, so it is guarded here as source: the six names are in the list, and the drop is
// still scoped to values that came from the file.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUNNY_ENV_NAMES } from "@/server/relay/config";

const config = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "..", "vitest.config.ts"), "utf8");
const dropped = (() => {
  const loop = /for \(const key of \[([\s\S]*?)\]\) \{\s*([^\n]*)\n/.exec(config);
  if (!loop) return null;
  return { names: [...loop[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]), body: loop[2] };
})();

describe("vitest.config.ts drops the Bunny settings it loads from .env.local", () => {
  it("found the drop list (a different array would make every check below vacuous)", () => {
    expect(dropped, "the drop loop was not found").not.toBeNull();
    expect(dropped!.names).toContain("RESEND_API_KEY"); // the list that existed before Task 21
    expect(dropped!.names.length).toBeGreaterThan(6);
  });

  it("lists every Bunny setting the app reads, and REPLAY_DRIVER", () => {
    expect(BUNNY_ENV_NAMES).toHaveLength(5);
    for (const name of [...BUNNY_ENV_NAMES, "REPLAY_DRIVER"]) expect(dropped!.names, name).toContain(name);
  });

  it("drops only what came from the file, so an exported value (the live probe's) survives", () => {
    expect(dropped!.body).toBe("if (fileOnly(key)) delete process.env[key];");
  });
});
