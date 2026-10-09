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

/** Code only: prose may NAME `tunable(…)` (the use-case passes it), code may not reach it. A `//` after `:` or a quote
 *  is a URL or a string, not a comment. */
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** config.ts's env-reading exports, derived from the file so a new one is covered without editing this test: every
 *  top-level export whose code reads `process.env`, or calls an export that does (to a fixpoint). `tunable` is one
 *  (D1: the use-case passes `tunable(…)` in; a domain file never calls it). */
const CONFIG_BLOCKS = codeOf(readFileSync(resolve(DOMAIN, "../config.ts"), "utf8"))
  .split(/^(?=export )/m)
  .map((block) => ({ name: /^export (?:async )?(?:function|const|let) (\w+)/.exec(block)?.[1], block }))
  .filter((b): b is { name: string; block: string } => b.name !== undefined);
const ENV_READERS: ReadonlySet<string> = (() => {
  const found = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, block } of CONFIG_BLOCKS) {
      if (found.has(name)) continue;
      if (/process\.env/.test(block) || [...found].some((r) => new RegExp(`\\b${r}\\(`).test(block))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return found;
})();
/** Where a domain file may import from: the constants, its siblings, and the zod-only capture contract. */
const ALLOWED_SOURCE = /^(\.\.\/config|\.\/[\w-]+|@\/server\/api-v1\/capture-schemas)$/;

describe("server/relay/domain is pure", () => {
  it("has the fifteen units (capture QR v2: T4a's stream-code, pairing, slot, poll-seconds; T4b's beat-answer, end-reason, phone-lost; PR-2 T2's auto-stream, phone-health; T6's health-reasons)", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "auto-stream.ts", "beat-answer.ts", "credits.ts", "end-reason.ts", "expiry.ts", "health-reasons.ts", "pairing.ts", "phone-health.ts",
      "phone-lost.ts", "poll-seconds.ts", "retention.ts", "runner.ts", "session.ts", "slot.ts", "stream-code.ts",
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

  // I-2 (B3 review). `process.env` above is only the literal text: a domain file could import `tunable` (or any other
  // env-reading export) from ../config and call it, and every scan above would stay green.
  it("never names an env-reading export of ../config — tunable() is the use-case's, passed in as a number", () => {
    // Anti-vacuity: the derivation found the readers, tunable among them.
    expect(ENV_READERS.has("tunable"), [...ENV_READERS].join(", ")).toBe(true);
    expect(ENV_READERS.size).toBeGreaterThanOrEqual(4);
    let scanned = 0;
    for (const f of files) {
      const code = codeOf(f.text);
      for (const reader of ENV_READERS) expect(code, `${f.name} names ${reader}`).not.toMatch(new RegExp(`\\b${reader}\\b`));
      scanned++;
    }
    expect(scanned).toBe(files.length);
    // Present twin: the scan sees code identifiers through the comment strip (pairing.ts uses the slack constant)…
    expect(codeOf(files.find((f) => f.name === "pairing.ts")!.text)).toMatch(/\bPHONE_SILENT_SLACK_SECONDS\b/);
    // …and the strip is what lets prose name tunable(…): at least one domain file does, in a comment.
    expect(files.some((f) => /\btunable\(/.test(f.text) && !/\btunable\(/.test(codeOf(f.text)))).toBe(true);
  });

  // PR-2 T6: api-v1/schemas.ts is also loaded by the standalone OpenAPI generator (node --experimental-strip-types, no resolver,
  // so no extensionless or `@/` import can be followed). The domain files it takes constants from must therefore import NOTHING.
  it("every domain file api-v1/schemas.ts imports (the generator loads it with no resolver) imports nothing at all", () => {
    const schemas = readFileSync(resolve(DOMAIN, "../../api-v1/schemas.ts"), "utf8");
    const loaded = [...codeOf(schemas).matchAll(/from "\.\.\/relay\/domain\/([\w-]+\.ts)"/g)].map((m) => m[1]!);
    expect(loaded, "anti-vacuity: the constants schemas.ts takes from the domain").toEqual(expect.arrayContaining(["auto-stream.ts", "health-reasons.ts"]));
    for (const name of loaded) {
      const f = files.find((x) => x.name === name);
      expect(f, `${name} is a domain file`).toBeDefined();
      expect(codeOf(f!.text), `${name} must import nothing`).not.toMatch(/^\s*(?:import|export\b[^\n]*\bfrom)\b/m);
    }
  });

  it("imports only from ../config, its siblings and the zod-only capture contract — no other module can bring the environment in", () => {
    let imports = 0;
    for (const f of files) {
      for (const [, source] of codeOf(f.text).matchAll(/\bfrom "([^"]+)"/g)) {
        expect(source, f.name).toMatch(ALLOWED_SOURCE);
        imports++;
      }
    }
    expect(imports).toBeGreaterThan(0);
  });
});
