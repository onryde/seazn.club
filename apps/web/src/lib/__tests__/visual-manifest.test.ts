// The visual gate's manifest is DATA that later waves append to (spec §4.2:
// "W1-E and R2 add manifest rows, never harness code"). A manifest the
// harness cannot run — a dangling mustDiffer id, a route placeholder no seed
// provides, an unknown check name — would fail at Playwright time, on a
// prod build, after a rebuild: minutes late and easy to misread as a product
// defect. This pure unit fails in seconds, in every CI job, with the row named.
//
// It is also where the gate's two CROSS-ROW comparisons get their permanent
// killers. `differingPairViolations` and `controlSetViolations` live in
// `manifest.ts` (a pure module) precisely so they can be driven from here with
// equal hashes and empty control sets — the vacuous inputs a browser run
// cannot easily be made to produce, and which previously needed a
// duplicate-row probe that had to be reverted by hand (fix round 1).
//
// Pure: no DB, no browser — and no import from `e2e/helpers.ts` (which would
// load `@playwright/test` and the whole helper module at import time). The
// seed KIND table lives in `manifest.ts` for exactly this reason (review
// finding 22); `seeds.ts` imports it from there.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  controlSetViolations,
  differingPairViolations,
  notInDomSentinel,
  parseManifest,
  resolveRoute,
  SEED_PARAMS,
} from "../../../e2e/visual/manifest";

/** apps/web — this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");
const MANIFEST = join(WEB, "e2e/visual/manifest.json");

function load() {
  return parseManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));
}

describe("e2e/visual/manifest.json", () => {
  it("parses, and is not empty (an empty manifest photographs nothing and passes)", () => {
    const m = load();
    expect(m.groups.length).toBeGreaterThan(0);
    for (const g of m.groups) expect(g.rows.length, `group ${g.id} has no rows`).toBeGreaterThan(0);
  });

  it("every route placeholder is provided by the group's seed kind", () => {
    for (const g of load().groups) {
      const params = Object.fromEntries(SEED_PARAMS[g.seed].map((k) => [k, "x"]));
      for (const r of g.rows) {
        expect(() => resolveRoute(r.route, params), `${g.id}/${r.id}: ${r.route}`).not.toThrow();
      }
    }
  });

  it("every mustDiffer and controlSetEqual reference names a row in the same group, and controlSetEqual rows carry a controlRoot", () => {
    for (const g of load().groups) {
      const ids = new Set(g.rows.map((r) => r.id));
      for (const [a, b] of g.mustDiffer) {
        expect(ids.has(a) && ids.has(b), `${g.id}: mustDiffer ${a}/${b}`).toBe(true);
        expect(a).not.toBe(b);
      }
      for (const [a, b] of g.controlSetEqual) {
        expect(ids.has(a) && ids.has(b), `${g.id}: controlSetEqual ${a}/${b}`).toBe(true);
        for (const id of [a, b]) {
          expect(
            g.rows.find((r) => r.id === id)!.controlRoot,
            `${g.id}/${id} has no controlRoot`,
          ).not.toBeNull();
        }
      }
    }
  });

  it("no row awaits a selector the branded 404 also satisfies", () => {
    // `shared/[orgSlug]/not-found.tsx` renders an <h1> inside the SAME
    // `<main>` the fixture page's layout provides, so `main h1` matched a
    // 404 — on which every check passes (no clips, no rails, few controls)
    // and both cross-row comparisons still hold. The whole group would have
    // signed off on a page that is not the fixture (fix round 1, Important 1).
    for (const g of load().groups) {
      for (const r of g.rows) {
        expect(
          /^(main )?h[1-6]$/.test(r.awaitSelector.trim()),
          `${g.id}/${r.id}: awaitSelector "${r.awaitSelector}" is a bare heading, which the branded 404 also renders — await something only this page draws`,
        ).toBe(false);
      }
    }
  });

  it("a check is either asserted or recorded as a known defect, never both, and a known defect explains itself", () => {
    for (const g of load().groups) {
      for (const r of g.rows) {
        for (const d of r.knownDefects) {
          expect(r.checks, `${g.id}/${r.id}: ${d.check} is asserted AND excused`).not.toContain(
            d.check,
          );
          expect(
            d.reason.length,
            `${g.id}/${r.id}: the ${d.check} reason must name the file and the owed fix`,
          ).toBeGreaterThan(40);
        }
      }
    }
  });

  it("rejects what the harness cannot run, BY NAME", () => {
    const base = {
      version: 1,
      groups: [
        {
          id: "g",
          seed: "none",
          rows: [
            {
              id: "r",
              route: "/",
              viewport: { width: 320, height: 568 },
              awaitSelector: "body",
            },
          ],
        },
      ],
    };
    const group = base.groups[0]!;
    const row = group.rows[0]!;
    // Each of these asserts the OFFENDING VALUE is in the message, not merely
    // that something threw: zod v4 strips `input` from a finalized issue, so
    // the stock "Invalid option" message never names it and an assertion
    // written as /no-such-check|invalid/ passed on the `invalid` branch
    // whatever the schema did (fix round 1, Minor).
    expect(() =>
      parseManifest({ ...base, groups: [{ ...group, rows: [{ ...row, checks: ["no-such-check"] }] }] }),
    ).toThrow(/no-such-check/);
    expect(() => parseManifest({ ...base, groups: [{ ...group, seed: "no-such-seed" }] })).toThrow(
      /no-such-seed/,
    );
    expect(() =>
      parseManifest({
        ...base,
        groups: [
          { ...group, rows: [{ ...row, knownDefects: [{ check: "no-such-check", reason: "x".repeat(50) }] }] },
        ],
      }),
    ).toThrow(/no-such-check/);
    expect(() =>
      parseManifest({ ...base, groups: [{ ...group, mustDiffer: [["r", "ghost"]] }] }),
    ).toThrow(/ghost/);
    expect(() => parseManifest({ ...base, groups: [{ ...group, rows: [row, row] }] })).toThrow(
      /duplicate/i,
    );
    expect(() =>
      parseManifest({
        ...base,
        groups: [
          {
            ...group,
            rows: [
              {
                ...row,
                checks: ["rails-a11y"],
                knownDefects: [{ check: "rails-a11y", reason: "x".repeat(50) }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/BOTH checks and knownDefects/);
    expect(() => parseManifest({ ...base, groups: [] })).toThrow(/empty|at least/i);
    // Positive pair: the minimal manifest above is valid.
    expect(() => parseManifest(base)).not.toThrow();
  });

  it("resolveRoute refuses an unresolved placeholder rather than fetching a literal '{fixtureId}'", () => {
    expect(resolveRoute("/a/{x}/b", { x: "1" })).toBe("/a/1/b");
    expect(() => resolveRoute("/a/{x}/{y}", { x: "1" })).toThrow(/\{y\}/);
  });

  it("differingPairViolations catches two identical pictures, and a pair that was never photographed", () => {
    const pairs = [["a", "b"] as const];
    expect(differingPairViolations(pairs, { a: "hash-one", b: "hash-two" })).toEqual([]);
    // The mutant this exists for: the spec used to compare hashes inline, and
    // deleting that loop left the suite green.
    expect(differingPairViolations(pairs, { a: "same", b: "same" })).toEqual([
      "a and b are pixel-identical (same) — nothing opened, or the size never applied",
    ]);
    expect(differingPairViolations(pairs, { a: "only-one" })).toEqual(["a/b: no picture for b"]);
    expect(differingPairViolations([], { a: "x" })).toEqual([]);
  });

  it("controlSetViolations refuses the two ways an equal control set means nothing", () => {
    const pairs = [["a", "b"] as const];
    expect(controlSetViolations(pairs, { a: ["Save", "Cancel"], b: ["Save", "Cancel"] })).toEqual(
      [],
    );
    // Both roots missing: the sentinel compares equal to itself and used to pass.
    const sentinel = notInDomSentinel("main");
    expect(controlSetViolations(pairs, { a: [sentinel], b: [sentinel] })).toEqual([
      `a: its controlRoot was not in the DOM (${sentinel})`,
      `b: its controlRoot was not in the DOM (${sentinel})`,
    ]);
    // Both roots present but matching no control: [] === [] used to pass too.
    expect(controlSetViolations(pairs, { a: [], b: [] })).toEqual([
      "a: its controlRoot matched NO controls — an empty set compares equal to anything",
      "b: its controlRoot matched NO controls — an empty set compares equal to anything",
    ]);
    // And it still catches a genuine difference, in order as well as membership.
    expect(
      controlSetViolations(pairs, { a: ["Save", "Cancel"], b: ["Cancel", "Save"] }).length,
    ).toBe(1);
    expect(controlSetViolations(pairs, { a: ["Save"], b: null })).toEqual([
      "b: no control set was captured (the row has no controlRoot?)",
    ]);
  });

  it("the capture spec exists where CI looks for it", () => {
    // The authoritative selection check is e2e-ci-wiring.test.ts › "runs every
    // spec file in at least one CI leg", which walks e2e/ recursively and
    // evaluates the REAL playwright.config.ts against ABSOLUTE paths. This
    // case used to re-type that config's regexes and test them against a
    // hand-typed relative literal — four assertions that could not fail, and a
    // path shape playwright.config.ts:112-118 explicitly says it does not
    // model. Only the file's existence has teeth here, so only that is kept.
    const spec = join(WEB, "e2e/visual/capture.spec.ts");
    expect(existsSync(spec), `${spec} is missing — the gate would silently run nothing`).toBe(true);
  });
});
