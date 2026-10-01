// The domain is pure by CONSTRUCTION, and this guard is what keeps it so
// after this wave: no `@/lib/db`, no `@/server/logger`, no `fetch(`, no
// `Date.now()`/`new Date()` without an argument, no import of an adapter or
// of the ports' fakes. A domain that quietly grew an `sql` import would still
// be green in every DB test — this is the only test that would notice.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DOMAIN = resolve(import.meta.dirname, "..");
const files = readdirSync(DOMAIN).filter((f) => f.endsWith(".ts")).map((f) => ({ name: f, text: readFileSync(join(DOMAIN, f), "utf8") }));

describe("server/relay/domain is pure", () => {
  it("has the nine units (capture QR v2 T4a added stream-code, pairing, slot and poll-seconds)", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "credits.ts", "expiry.ts", "pairing.ts", "poll-seconds.ts", "retention.ts", "runner.ts", "session.ts", "slot.ts", "stream-code.ts",
    ]);
  });
  it("imports nothing impure and never reads the clock", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(/from "@\/lib\/db"|from "@\/server\/logger"|from "\.\.\/(ports|fakes|ingest-cf|runner-fly|fly-client|drivers|crypto|secret-columns|tokens)"/);
      expect(f.text, f.name).not.toMatch(/\bfetch\(|Date\.now\(\)|new Date\(\)|setTimeout|process\.env/);
    }
    // Present twin: the one allowed import (constants) IS used.
    expect(files.find((f) => f.name === "expiry.ts")!.text).toMatch(/from "\.\.\/config"/);
  });
});
