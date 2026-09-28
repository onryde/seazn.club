// A23 (lane C amendments, OWNER 2026-09-28): the provider adapter is Fly-specific and the application layer must not be.
// `usecases/stream-sessions.ts` used to import `createFailedFrom` from `runner-fly.ts` — Fly's error classification
// inside the application layer, i.e. a second provider would have had to be taught to throw Fly's error type. The port
// (`ports.ts`) now declares ONE provider-neutral create failure, `RunnerCreateError`, and this guard keeps the adapter's
// vocabulary on its own side of it: no file under `server/usecases/**` or `server/relay/domain/**` may import the Fly
// adapter or its client. Comments may still NAME them (a comment is not an import), so only import forms are matched.
//
// Anti-vacuity (TEST-STRATEGY rule 2): the walk reports how many files it read, zero is a failure, the file that used to
// leak must be among them, and the detector is shown to FIRE on a real import before its silence is believed.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "..", "..");
const GUARDED = [join(SERVER, "usecases"), join(SERVER, "relay", "domain")];

/** Every import form that could pull a module in: `from "…"`, a side-effect `import "…"`, a dynamic `import("…")` and
 *  `require("…")`, with or without an extension. Anchored on the quoted SPECIFIER's last path segment. */
const FLY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'][^"']*\b(?:runner-fly|fly-client)(?:\.[cm]?[jt]s)?["']/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(?:[cm]?[jt]sx?)$/.test(e.name) ? [p] : [];
  });
}

describe("A23: the application layer and the domain never import the Fly adapter", () => {
  it("the detector fires on a real import (the positive twin) and ignores a comment that merely names the file", () => {
    // fakes.ts sits OUTSIDE the guarded trees and legitimately builds a real FlyApiError (lane C A3).
    const fakes = readFileSync(join(SERVER, "relay", "fakes.ts"), "utf8");
    expect(fakes).toMatch(FLY_IMPORT);
    for (const form of [`import { x } from "@/server/relay/runner-fly";`, `import "../fly-client.ts";`, `await import("./runner-fly")`, `require('../../relay/fly-client')`]) {
      expect(form, form).toMatch(FLY_IMPORT);
    }
    expect("// runner-fly.ts `adoptNamed`: the refusal id is the only handle").not.toMatch(FLY_IMPORT);
    expect(`import { flyish } from "./runner-flyover";`).not.toMatch(FLY_IMPORT);
  });

  it("no file under server/usecases/** or server/relay/domain/** imports runner-fly or fly-client", () => {
    const files = GUARDED.flatMap(walk);
    const names = files.map((f) => relative(SERVER, f));
    expect(files.length, "the walk read nothing").toBeGreaterThan(0);
    expect(names).toContain(join("usecases", "stream-sessions.ts"));      // the file that leaked (A23)
    expect(names).toContain(join("relay", "domain", "runner.ts"));        // the domain's half of the walk is not empty either
    const offenders = files.filter((f) => FLY_IMPORT.test(readFileSync(f, "utf8"))).map((f) => relative(SERVER, f));
    expect(offenders, `walked ${files.length} files`).toEqual([]);
  });
});
