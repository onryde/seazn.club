// The visual gate (spec §4.2). Walks e2e/visual/manifest.json: seed → one
// context per row (viewport ÷ zoom, deviceScaleFactor = zoom — real browser
// zoom, not CSS zoom) → await the state → paint the backdrop → PNG + sha256
// → the row's checks → the group's cross-row assertions → report.json.
//
// Recurring class 10, the harness's own vacuous mode, is closed five ways:
// a group asserts the ids it photographed match the ids it declared; every
// `mustDiffer` pair is compared by hash; every `controlSetEqual` pair must be
// non-empty and really in the DOM; every box a check EXCUSED must appear in
// the row's declared `exempt` list; and the LAST assertion of every group runs
// after every row's state was awaited. There is no env-var skip: a run that
// photographs nothing fails.
//
// Lives under e2e/visual/ as a .spec.ts so the parallel project's catch-all
// "rest" leg runs it in CI with no config edit (e2e-ci-wiring.test.ts proves
// the selection against the real config). Locally, VISUAL_DIR points the PNGs
// somewhere durable; the default is apps/web/test-results/visual/<TAG>.
import { test, expect, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TAG, expectNoHorizontalScroll } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import {
  controlSetViolations,
  differingPairViolations,
  EXEMPT_KINDS,
  parseManifest,
  resolveRoute,
  type KnownDefectCheck,
  type VisualGroup,
  type VisualRow,
} from "./manifest";
import { seedFor } from "./seeds";
import {
  applyBackdrop,
  controlSet,
  expectHitTargetsByPoint,
  expectNoClip,
  expectRailsA11y,
  expectTruncateChain,
  type Seen,
} from "./asserts";

/** A real screenshot of a rendered page is never this small; a blank or an
 *  aborted capture is (T1 prompt item 6: "exists and is > 1 KB"). */
const MIN_PNG_BYTES = 1024;

/** apps/web. Anchored on this file rather than on `process.cwd()`: a run
 *  launched with `--config apps/web/playwright.config.ts` from the repo root
 *  would otherwise read the manifest from the wrong place and fail the whole
 *  file at COLLECTION, which reads as "0 tests" rather than as a bad path. */
const WEB = resolve(import.meta.dirname, "../..");
const AUTH_STATE = join(WEB, "e2e/.auth/pro.json");
const OUT = process.env.VISUAL_DIR ?? join(WEB, "test-results", "visual", TAG);
const manifest = parseManifest(
  JSON.parse(readFileSync(join(import.meta.dirname, "manifest.json"), "utf8")),
);

interface Shot {
  id: string;
  file: string;
  /** PNG byte length — the anti-vacuity guard (a real screenshot is > 1 KB). */
  bytes: number;
  sha256: string;
  controls: string[] | null;
  rails: string[];
  /** What each check INSPECTED (counts + a sample), printed on pass too. */
  seen: Record<string, Seen>;
  /** Every box every check EXCUSED, merged and complete. */
  exempt: Record<string, string[]>;
}

async function captureRow(
  browser: Browser,
  group: VisualGroup,
  row: VisualRow,
  params: Record<string, string>,
): Promise<Shot> {
  const context = await browser.newContext({
    viewport: {
      width: Math.round(row.viewport.width / row.zoom),
      height: Math.round(row.viewport.height / row.zoom),
    },
    deviceScaleFactor: row.zoom,
    storageState: row.auth ? AUTH_STATE : { cookies: [], origins: [] },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const label = `${group.id}/${row.id}`;
  try {
    await page.goto(resolveRoute(row.route, params), { waitUntil: "load" });
    await expect(
      page.locator(row.awaitSelector).first(),
      `${label}: ${row.awaitSelector} never rendered`,
    ).toBeVisible();
    await dismissCookieBanner(page);
    if (row.backdrop) await applyBackdrop(page, row.backdrop);
    // Fonts BEFORE the ladder settle: measuring in a fallback face, then
    // swapping to the display face, re-widens the full name under
    // overflow:hidden and no-clip reds (stream-overlay/overlay-bar-1920,
    // run 34784354416 — 588px in a 67px cell after data-ladder-settled).
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (group.seed === "overlay-fixture" && row.route.includes("style=bar")) {
      await expect(
        page.locator('.ovl-team-name[data-ladder-settled="true"]'),
        `${label}: the name ladder has not settled — a full name is still clipped under overflow: hidden`,
      ).toHaveCount(2, { timeout: 15_000 });
    }
    const file = join(OUT, `${group.id}--${row.id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const bytes = readFileSync(file);
    // PNG IHDR width at bytes 16–19: at zoom 1.25 the CSS viewport is 256 px
    // but the PICTURE is 320 px wide — the only proof the DPR actually applied.
    // Compared within a pixel rather than exactly, because the CSS viewport is
    // `round(w / zoom)` and `round(w / zoom) * zoom` is only integral for zooms
    // that divide the width: 320 at `zoom: 1.1` renders 291 CSS px and a
    // 320.1 px picture, which an equality would red for no reason. A mutant
    // that drops the DPR misses by tens of pixels, so ±1 loses nothing.
    const pngWidth = bytes.readUInt32BE(16);
    expect(
      Math.abs(pngWidth - row.viewport.width),
      `${label}: PNG width — deviceScaleFactor did not apply (picture ${pngWidth}px, row declares ${row.viewport.width}px at zoom ${row.zoom})`,
    ).toBeLessThanOrEqual(1);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(`${file}.sha256`, sha256);

    const seen: Record<string, Seen> = {};
    for (const check of row.checks) {
      switch (check) {
        case "no-horizontal-scroll":
          await expectNoHorizontalScroll(page);
          seen[check] = { inspected: 1, sample: ["document"] };
          break;
        case "no-clip":
          seen[check] = await expectNoClip(page, row.controlRoot ?? "body", label);
          break;
        case "hit-targets":
          seen[check] = await expectHitTargetsByPoint(page, row.controlRoot ?? "body", label);
          break;
        case "truncate-chain":
          seen[check] = await expectTruncateChain(page, label);
          break;
        case "rails-a11y":
          break; // inspected on EVERY row below for the report; asserted only when listed
      }
    }
    // Rails are inspected on every row so report.json never says "no rails"
    // for a row that simply did not list the check (review finding 20).
    const rails = await expectRailsA11y(page, label, {
      assert: row.checks.includes("rails-a11y"),
    });
    if (row.checks.includes("rails-a11y")) {
      seen["rails-a11y"] = { inspected: rails.rails.length, sample: rails.rails.slice(0, 5) };
    }

    // A check this row records as a KNOWN DEFECT is RE-RUN and its offenders
    // compared, as a SET, against the ones the row declares. Two directions,
    // both of which "non-empty" missed: the row reds when the recorded defect
    // disappears (someone fixed the page — restore the check), AND when a
    // DIFFERENT offender joins it on the same page.
    //
    // The map is keyed by check rather than branched on one name. A
    // `knownDefects` entry for any other check used to evaluate `[]` and fail
    // unconditionally, announcing "the page was FIXED" — false, and aimed at
    // a wave doing exactly what this harness invites (append a row, touch no
    // harness code). `KNOWN_DEFECT_CHECKS` now refuses those at parse time,
    // and this throws if a listed check reaches here with nothing captured,
    // so the list and the wiring cannot drift apart silently.
    const offendersByCheck: Partial<Record<KnownDefectCheck, string[]>> = {
      "rails-a11y": rails.offenderIds,
    };
    for (const defect of row.knownDefects) {
      const found = offendersByCheck[defect.check];
      if (found === undefined) {
        throw new Error(
          `${label}: "${defect.check}" is in KNOWN_DEFECT_CHECKS but capture.spec.ts captures no offenders for it — wire it into offendersByCheck before a manifest row can record it.`,
        );
      }
      expect(
        [...found].sort(),
        `${label}: the ${defect.check} offenders no longer match the ones this row records. If the list is now EMPTY the page was fixed — delete the knownDefects entry and add "${defect.check}" back to this row's checks. If it GREW, a second defect appeared on the same page and is not recorded. Recorded reason: ${defect.reason}`,
      ).toEqual([...defect.offenders].sort());
    }

    // Every box any check EXCUSED, held to the list the row declares. An
    // exemption nothing checks would let the next overflow hide behind it
    // (AGENTS.md class 23) — so a NEW bleed ancestor, a NEW inline-exempt
    // link or a NEW off-viewport control fails here until it is written down.
    // `EXEMPT_KINDS` is derived from the schema, so a fourth kind is held to a
    // declared list the moment it exists rather than landing in report.json
    // asserted against nothing.
    const exempt: Record<string, string[]> = Object.fromEntries(EXEMPT_KINDS.map((k) => [k, []]));
    for (const s of Object.values(seen)) {
      for (const [kind, list] of Object.entries(s.exempt ?? {})) {
        if (!(kind in exempt)) {
          throw new Error(
            `${label}: a check returned exemption kind "${kind}", which no manifest row can declare — add it to ExemptShape in manifest.ts.`,
          );
        }
        exempt[kind] = [...exempt[kind]!, ...list];
      }
    }
    for (const kind of EXEMPT_KINDS) {
      expect(
        [...exempt[kind]!].sort(),
        `${label}: the ${kind} exemptions the checks made do not match the row's declared exempt.${kind}. Every excused box must be written down in manifest.json, or the next one hides behind it.`,
      ).toEqual([...row.exempt[kind]].sort());
    }

    const controls = row.controlRoot ? await controlSet(page, row.controlRoot) : null;
    // Print what was SEEN on pass, not only on fail (_RULES.md §Verification;
    // review finding 12): counts and a sample per check, beside the picture.
    console.log(
      `[visual ${label}] ${row.viewport.width}x${row.viewport.height}@${row.zoom}` +
        `${row.backdrop ? ` backdrop=${row.backdrop}` : ""} ` +
        `png=${bytes.length}B sha=${sha256.slice(0, 12)} rails=${rails.rails.length}` +
        (controls ? ` controls=${controls.length}` : "") +
        ` exempt=${JSON.stringify(exempt)} seen=${JSON.stringify(seen)}`,
    );
    return {
      id: row.id,
      file,
      bytes: bytes.length,
      sha256,
      controls,
      rails: rails.rails,
      seen,
      exempt,
    };
  } finally {
    await context.close();
  }
}

test.describe("visual gate", () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });

  for (const group of manifest.groups) {
    test(`${group.id}: ${group.rows.length} rows`, async ({ browser, page }) => {
      test.setTimeout(30_000 + group.rows.length * 20_000);
      const params = await seedFor(group.seed, page);
      const shots: Shot[] = [];
      for (const row of group.rows) shots.push(await captureRow(browser, group, row, params));

      // Every declared image exists on disk. The right-hand side is built from
      // `group.rows`, so a short `shots` fails on length — that is the count
      // guard. (An `shots.map(s => s.id)` vs `group.rows.map(r => r.id)` line
      // used to sit here as well: `shots` is built by iterating `group.rows`
      // and copying `row.id` verbatim, so neither side could move
      // independently. It was a tautology in a different shape and is gone.)
      expect(
        shots.map((s) => existsSync(s.file)),
        `${group.id}: a PNG is missing`,
      ).toEqual(group.rows.map(() => true));

      // Both cross-row comparisons are pure functions in ./manifest so they
      // have permanent unit killers (visual-manifest.test.ts) rather than a
      // duplicate-row probe that has to be reverted.
      const hashById = Object.fromEntries(shots.map((s) => [s.id, s.sha256]));
      expect(
        differingPairViolations(group.mustDiffer, hashById),
        `${group.id}: mustDiffer`,
      ).toEqual([]);

      const controlsById = Object.fromEntries(shots.map((s) => [s.id, s.controls]));
      for (const [a, b] of group.controlSetEqual) {
        const ca = controlsById[a] ?? [];
        const cb = controlsById[b] ?? [];
        console.log(
          `[control-set ${group.id}] ${a}: ${ca.length} controls\n  ${ca.join("\n  ")}\n${b}: ${cb.length} controls\n  ${cb.join("\n  ")}`,
        );
      }
      expect(
        controlSetViolations(group.controlSetEqual, controlsById),
        `${group.id}: controlSetEqual`,
      ).toEqual([]);

      writeFileSync(
        join(OUT, `${group.id}.report.json`),
        JSON.stringify({ group: group.id, seed: params, shots }, null, 2),
      );
      // LAST, after every state was awaited and every picture written: the
      // group is not vacuous. Two guards a broken run actually violates
      // (review 2026-09-08 finding 9 — the previous `sha256.length === 64`
      // could never fire): every PNG is a real picture, and where the group
      // declares any mustDiffer pair, the group's hashes are not all one value.
      //
      // The expectation is built from `group.rows`, not from `shots`. Compared
      // against itself this block asserted `shots === shots` and would have
      // passed on an EMPTY run if it were ever hoisted above the capture loop
      // — the one property in this file that had no mutant. Anchored here it
      // has one: move it up and `[]` fails against four declared rows.
      expect(
        shots.map((s) => [s.id, s.bytes > MIN_PNG_BYTES]),
        `${group.id}: a PNG under ${MIN_PNG_BYTES} bytes is a blank or aborted capture`,
      ).toEqual(group.rows.map((r) => [r.id, true]));
      if (group.mustDiffer.length > 0) {
        expect(
          new Set(shots.map((s) => s.sha256)).size,
          `${group.id}: every picture is identical — nothing opened`,
        ).toBeGreaterThan(1);
      }
    });
  }

  // The checks' own killers, for the branches no route photographed today can
  // reach. `expectRailsA11y`'s `tabindex="0"` arm is the one that matters:
  // nothing on the seeded football fixture carries one (`tab-rail.tsx`
  // deliberately does not, per its roving-tabindex note), so deleting that
  // whole arm left the suite green — an unreached branch, not a satisfied one
  // (fix round 1, Important 7). A synthetic rail reaches it permanently,
  // without a probe anyone has to remember to revert.
  test("rails-a11y: the tabindex arm and the unreachable arm both fire", async ({ page }) => {
    // Every rail carries a `data-testid`, so the offender strings are
    // ATTRIBUTABLE. Without one all four render the identical
    // `div 400px in 100px` and an exact-set assertion cannot tell an offender
    // raised against the wrong rail from the right one; and the "no offender
    // for the good rail" check was written as a filter on `"Named rail"`,
    // which the offender string never contains — it passed in every state,
    // including the one its own comment claimed it caught (fix round 2).
    await page.setContent(`
      <div data-testid="rail-bare" style="width:100px;overflow-x:auto">
        <div style="width:400px">no tabindex, no focusable child</div>
      </div>
      <div data-testid="rail-tabbed" tabindex="0" style="width:100px;overflow-x:auto">
        <div style="width:400px">tabindex, but no role and no name</div>
      </div>
      <div data-testid="rail-complete" tabindex="0" role="region" aria-label="Named rail" style="width:100px;overflow-x:auto">
        <div style="width:400px">complete</div>
      </div>
      <div data-testid="rail-viachild" style="width:100px;overflow-x:auto">
        <a href="#x" style="display:block;width:400px">reachable via a focusable child</a>
      </div>`);
    const { rails, offenders, offenderIds } = await expectRailsA11y(page, "probe", {
      assert: false,
    });
    expect(rails.length, "all four synthetic rails should be seen").toBe(4);
    // Exactly which rails offend — the two good ones must not appear.
    expect([...offenderIds].sort()).toEqual([
      "div[data-testid=rail-bare]",
      "div[data-testid=rail-tabbed]",
    ]);
    // …and exactly which rules each broke, named against its own rail.
    expect([...offenders].sort()).toEqual(
      [
        "div[data-testid=rail-bare] 400px in 100px: not keyboard-reachable (no tabindex=0, no focusable child)",
        "div[data-testid=rail-tabbed] 400px in 100px: tabindex=0 without a role",
        "div[data-testid=rail-tabbed] 400px in 100px: tabindex=0 without an accessible name",
      ].sort(),
    );
  });

  // The bleed exemption's ACCOUNTING, which no photographed route can falsify:
  // every real page either has a bleeding rail (exempt, correctly) or nothing
  // overflowing at all. A box that overflows MORE than the rails inside it
  // reach must still be a clip, or `main` is permanently excused on every
  // fixture row and a too-wide fixed child rides in behind the tab strip
  // (fix round 1, Important 2). A too-wide fixed child never reports itself:
  // its own scrollWidth equals its clientWidth, so its ancestor is the only
  // box that can.
  test("no-clip: a bleeding rail is excused, an overhang it cannot account for is not", async ({
    page,
  }) => {
    const bleedOnly = `
      <main style="width:288px;overflow-x:visible">
        <div style="width:320px;margin:0 -16px;overflow-x:auto">
          <div style="width:400px">a rail that bleeds 16px through the gutter</div>
        </div>
      </main>`;
    await page.setContent(bleedOnly);
    const clean = await expectNoClip(page, "main", "probe-bleed");
    expect(clean.exempt?.bleeds, "the bleeding rail's ancestor should be excused").toEqual(["main"]);

    // Same rail, plus a fixed child 80px wider than the box. `main` now
    // overflows by more than the rail's 16px reach, so it is a clip.
    await page.setContent(`
      <main style="width:288px;overflow-x:visible">
        <div style="width:320px;margin:0 -16px;overflow-x:auto">
          <div style="width:400px">a rail that bleeds 16px through the gutter</div>
        </div>
        <div style="width:368px">a fixed child far too wide for the box</div>
      </main>`);
    await expect(expectNoClip(page, "main", "probe-clip")).rejects.toThrow(/clipped content/);
  });

  // `truncate-chain`'s percentage-vs-length distinction, which the photographed
  // routes cannot exercise either: treating any `max-width` as a width bound
  // skipped the element before the walk began, and that is exactly the shape of
  // the defect this gate found in court-card.tsx (fix round 1, Important 4).
  test("truncate-chain: a length cap ends the walk, a percentage cap does not", async ({ page }) => {
    const span = (extra: string) =>
      `<div style="display:flex;flex-direction:row;width:200px">
         <span style="${extra};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">a very long entrant name indeed</span>
       </div>`;
    // `max-width: 100%` does NOT save it — min-width:auto still refuses to shrink.
    await page.setContent(span("max-width:100%"));
    await expect(expectTruncateChain(page, "probe-pct")).rejects.toThrow(/without min-width:0/);
    // A LENGTH cap does: the box can never exceed it whatever the ancestors do.
    await page.setContent(span("max-width:120px"));
    await expect(expectTruncateChain(page, "probe-len")).resolves.toMatchObject({ inspected: 1 });
    // And the repair works.
    await page.setContent(span("max-width:100%;min-width:0"));
    await expect(expectTruncateChain(page, "probe-fixed")).resolves.toMatchObject({ inspected: 1 });
  });
});
