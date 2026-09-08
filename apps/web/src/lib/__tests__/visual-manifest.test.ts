// The visual gate's manifest is DATA that later waves append to (spec §4.2:
// "W1-E and R2 add manifest rows, never harness code"). A manifest the
// harness cannot run — a dangling mustDiffer id, a route placeholder no seed
// provides, an unknown check name — would fail at Playwright time, on a
// prod build, after a rebuild: minutes late and easy to misread as a product
// defect. This pure unit fails in seconds, in every CI job, with the row named.
//
// Pure: no DB, no browser — and no import from `e2e/helpers.ts` (which would
// load `@playwright/test` and the whole helper module at import time). The
// seed KIND table lives in `manifest.ts` for exactly this reason (review
// finding 22); `seeds.ts` imports it from there.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifest, resolveRoute, SEED_PARAMS } from "../../../e2e/visual/manifest";

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

  it("rejects what the harness cannot run, by name", () => {
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
    expect(() =>
      parseManifest({ ...base, groups: [{ ...group, rows: [{ ...row, checks: ["no-such-check"] }] }] }),
    ).toThrow(/no-such-check|invalid/i);
    expect(() => parseManifest({ ...base, groups: [{ ...group, seed: "no-such-seed" }] })).toThrow(
      /no-such-seed|invalid/i,
    );
    expect(() =>
      parseManifest({ ...base, groups: [{ ...group, mustDiffer: [["r", "ghost"]] }] }),
    ).toThrow(/ghost/);
    expect(() => parseManifest({ ...base, groups: [{ ...group, rows: [row, row] }] })).toThrow(
      /duplicate/i,
    );
    expect(() => parseManifest({ ...base, groups: [] })).toThrow(/empty|at least/i);
    // Positive pair: the minimal manifest above is valid.
    expect(() => parseManifest(base)).not.toThrow();
  });

  it("resolveRoute refuses an unresolved placeholder rather than fetching a literal '{fixtureId}'", () => {
    expect(resolveRoute("/a/{x}/b", { x: "1" })).toBe("/a/1/b");
    expect(() => resolveRoute("/a/{x}/{y}", { x: "1" })).toThrow(/\{y\}/);
  });

  it("the capture spec is a .spec.ts outside every carve-out, so the parallel 'rest' leg selects it", () => {
    // The authoritative check is e2e-ci-wiring.test.ts › "runs every spec
    // file in at least one CI leg", which evaluates the REAL config; this
    // case pins the two facts that make that true, so a rename of the file
    // or the directory fails here with the reason.
    const path = "/e2e/visual/capture.spec.ts";
    expect(existsSync(join(WEB, path.slice(1))), `${path} is missing`).toBe(true);
    expect(/\.(spec|test)\.[cm]?[jt]sx?$/.test(path), "default testMatch").toBe(true);
    expect(/[\\/]e2e[\\/]walkthrough[\\/]/.test(path), "not the walkthrough carve-out").toBe(false);
    expect(/mobile\.spec\.ts/.test(path), "not the mobile matrix").toBe(false);
    expect(
      /(scorepad-v3-cricket|marketing-ai-demo|board-v3)\.spec\.ts/.test(path),
      "not PARALLEL_HEAVY",
    ).toBe(false);
  });
});
