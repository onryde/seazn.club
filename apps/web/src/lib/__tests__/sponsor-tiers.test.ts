// R4 sponsors on stream, S3 (F10): the tier list moves to a client-safe lib so the pure planner (S4) and the overlay
// card can read it. The weights are the owner's D9 table, typed here from the ruling — never read back from the code
// under test — and every later test of the rotation derives from SPONSOR_TIER_WEIGHTS, so this file is the one place the
// declaration is pinned to the ruling. The DB's tier CHECKs agreeing with this list is the DB-backed half
// (server/sponsors/__tests__/migration.test.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";
import { SPONSOR_TIERS as UI_TIERS } from "@/components/org-sponsors";

/** Spec 2026-10-27 §1: the four V283 tiers, rank order (title highest). */
const SPEC_TIERS = ["title", "gold", "silver", "partner"];
/** Owner ruling D9: title 3, gold 2, silver 1, partner 1. */
const D9_WEIGHTS = { title: 3, gold: 2, silver: 1, partner: 1 };

describe("lib/sponsor-tiers — the client-safe tier authority (F10)", () => {
  it("lists the spec's four tiers in rank order", () => {
    expect([...SPONSOR_TIERS]).toEqual(SPEC_TIERS);
  });

  it("every SPONSOR_TIERS member has a positive integer weight, and no weight names a tier outside the list (count reported, 0 checked ⇒ fail)", () => {
    let checked = 0;
    for (const tier of SPONSOR_TIERS) {
      const w = SPONSOR_TIER_WEIGHTS[tier];
      expect(Number.isInteger(w) && w > 0, `${tier} weighs ${String(w)}`).toBe(true);
      checked++;
    }
    expect(checked, "tiers checked").toBe(SPEC_TIERS.length);
    expect(checked).toBeGreaterThan(0);
    // The reverse direction: a stray weight for a tier that does not exist is a typo the planner would never read.
    expect(Object.keys(SPONSOR_TIER_WEIGHTS).sort()).toEqual([...SPONSOR_TIERS].sort());
  });

  it("the weights are the owner's D9 table", () => {
    expect({ ...SPONSOR_TIER_WEIGHTS }).toEqual(D9_WEIGHTS);
  });

  it("the weights cannot be changed at runtime (one authority, no caller rewrites it)", () => {
    expect(Object.isFrozen(SPONSOR_TIER_WEIGHTS)).toBe(true);
  });

  it("is client-safe: the module imports nothing (the usecase it replaces imports the email outbox)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "sponsor-tiers.ts"), "utf8");
    expect(src.length, "read the module").toBeGreaterThan(0);
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it("final review m4: the console's tier list IS this one (the same array, not a copy)", () => {
    expect(UI_TIERS).toBe(SPONSOR_TIERS);
  });

  it("final review m4: no other production file spells the four tiers as a list - SQL binds SPONSOR_TIERS instead (files scanned reported)", () => {
    const SRC = join(import.meta.dirname, "../..");
    // The API schema is the one exemption: openapi-gen cannot follow `@/` imports, so its enum stays a literal, and
    // server/sponsors/__tests__/migration.test.ts pins it to SPONSOR_TIERS.
    const EXEMPT = new Set(["lib/sponsor-tiers.ts", "server/api-v1/schemas.ts"]);
    const LIST = /["']title["']\s*,\s*["']gold["']\s*,\s*["']silver["']\s*,\s*["']partner["']/;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    const offenders = files.map((f) => relative(SRC, f)).filter((rel) => !EXEMPT.has(rel) && LIST.test(readFileSync(join(SRC, rel), "utf8")));
    expect(files.length, "production files scanned").toBeGreaterThan(500);
    expect(offenders).toEqual([]);
    // Not vacuous: the authority itself matches.
    expect(LIST.test(readFileSync(join(SRC, "lib/sponsor-tiers.ts"), "utf8"))).toBe(true);
  });
});
