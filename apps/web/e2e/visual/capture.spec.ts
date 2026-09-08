// The visual gate (spec §4.2). Walks e2e/visual/manifest.json: seed → one
// context per row (viewport ÷ zoom, deviceScaleFactor = zoom — real browser
// zoom, not CSS zoom) → await the state → paint the backdrop → PNG + sha256
// → the row's checks → the group's cross-row assertions → report.json.
//
// Recurring class 10, the harness's own vacuous mode, is closed three ways:
// a group asserts it wrote exactly its row count; every `mustDiffer` pair is
// compared by hash; and the LAST assertion of every group runs after every
// row's state was awaited. There is no env-var skip: a run that photographs
// nothing fails.
//
// Lives under e2e/visual/ as a .spec.ts so the parallel project's catch-all
// "rest" leg runs it in CI with no config edit (visual-manifest.test.ts
// proves the selection). Locally, VISUAL_DIR points the PNGs somewhere
// durable; the default is apps/web/test-results/visual/<TAG> (gitignored).
import { test, expect, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TAG, expectNoHorizontalScroll } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { parseManifest, resolveRoute, type VisualGroup, type VisualRow } from "./manifest";
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
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const file = join(OUT, `${group.id}--${row.id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const bytes = readFileSync(file);
    // PNG IHDR width at bytes 16–19: at zoom 1.25 the CSS viewport is 256 px
    // but the PICTURE is 320 px wide — the only proof the DPR actually applied.
    expect(
      bytes.readUInt32BE(16),
      `${label}: PNG width — deviceScaleFactor did not apply`,
    ).toBe(row.viewport.width);
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
    const controls = row.controlRoot ? await controlSet(page, row.controlRoot) : null;
    // Print what was SEEN on pass, not only on fail (_RULES.md §Verification;
    // review finding 12): counts and a sample per check, beside the picture.
    console.log(
      `[visual ${label}] ${row.viewport.width}x${row.viewport.height}@${row.zoom} ` +
        `png=${bytes.length}B sha=${sha256.slice(0, 12)} rails=${rails.rails.length}` +
        (controls ? ` controls=${controls.length}` : "") +
        ` seen=${JSON.stringify(seen)}`,
    );
    return { id: row.id, file, bytes: bytes.length, sha256, controls, rails: rails.rails, seen };
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

      // Every declared image exists on disk — the harness did not skip a row.
      expect(
        shots.map((s) => existsSync(s.file)),
        `${group.id}: a PNG is missing`,
      ).toEqual(group.rows.map(() => true));
      expect(shots.length, `${group.id}: wrote fewer images than rows`).toBe(group.rows.length);

      const byId = new Map(shots.map((s) => [s.id, s]));
      for (const [a, b] of group.mustDiffer) {
        expect(
          byId.get(a)!.sha256,
          `${group.id}: ${a} and ${b} are pixel-identical — nothing opened, or the size never applied`,
        ).not.toBe(byId.get(b)!.sha256);
      }
      for (const [a, b] of group.controlSetEqual) {
        const ca = byId.get(a)!.controls!;
        const cb = byId.get(b)!.controls!;
        console.log(
          `[control-set ${group.id}] ${a}: ${ca.length} controls\n  ${ca.join("\n  ")}\n${b}: ${cb.length} controls\n  ${cb.join("\n  ")}`,
        );
        expect(
          ca,
          `${group.id}: control SET differs between ${a} and ${b} (membership, order or repeats)`,
        ).toEqual(cb);
      }

      writeFileSync(
        join(OUT, `${group.id}.report.json`),
        JSON.stringify({ group: group.id, seed: params, shots }, null, 2),
      );
      // LAST, after every state was awaited and every picture written: the
      // group is not vacuous. Two guards a broken run actually violates
      // (review 2026-09-08 finding 9 — the previous `sha256.length === 64`
      // could never fire): every PNG is a real picture, and where the group
      // declares any mustDiffer pair, the group's hashes are not all one value.
      expect(
        shots.map((s) => [s.id, s.bytes > MIN_PNG_BYTES]),
        `${group.id}: a PNG under ${MIN_PNG_BYTES} bytes is a blank or aborted capture`,
      ).toEqual(shots.map((s) => [s.id, true]));
      if (group.mustDiffer.length > 0) {
        expect(
          new Set(shots.map((s) => s.sha256)).size,
          `${group.id}: every picture is identical — nothing opened`,
        ).toBeGreaterThan(1);
      }
    });
  }
});
