import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { TAG, apiJson, addEntrantsViaApi, divisionPath } from "./helpers";

// The Swiss shape legend (owner-approved 2026-09-22, option B) — one line under
// a swiss stage's title on the competition desk:
//
//   3 rounds · 5 matches + 1 bye per round · 18 fixtures
//
// WHY THIS SPEC EXISTS AND THE UNIT TESTS DO NOT COVER IT. `apps/web` vitest is
// `environment: "node"`: it can read the markup a builder produced, and nothing
// else. It cannot see whether the page actually SUPPLIES the roster and the
// stage status the legend needs, whether the line survives the real CSS cascade
// at a phone width, or whether it pushes the page into horizontal scroll. Every
// one of those is a way this feature could ship inert while a green unit suite
// says otherwise.
//
// THE DEFECT IT GUARDS. A Swiss stage's later rounds kept shells minted for an
// OLD field size after the roster moved, so those rounds offered fewer matches
// than the field needed and the newcomers had nowhere to be seated. Nothing on
// the screen said so. The `stale` case below reproduces exactly that shape — 18
// rows minted for a field of 12, then three withdrawals — and pins that the
// legend prints what the CURRENT FIELD needs (4 matches + 1 bye) rather than
// what the rows happen to hold. An implementation that counts fixture rows
// passes every other case here and fails that one.
//
// THE TWO STATES ADDED 2026-09-22 (reviewer findings, owner-approved), which
// only a browser can settle because both are about what a page RENDERS rather
// than what a builder returns:
//  - `complete-*`: the stage is played out and completed through the real
//    endpoints, so the row really carries `status = 'complete'`. Its per-round
//    clause is dropped — otherwise a post-event withdrawal rewrites a stage
//    that played perfectly correctly into an accusation.
//  - `empty-*` / `one-entrant-*`: a stage is created BEFORE anyone signs up, so
//    "0 matches per round" was the first thing an organiser ever saw on it.
//    There must be NO line at all. These are the cases where this spec, not the
//    unit suite, is the one that can tell the page apart from the builder.
//
// SHOTS. Set `SWISS_LEGEND_SHOTS=<dir>` to also write one cropped PNG per case
// per width (for a visual sign-off). Unset — which is how CI runs it — nothing
// is written and the assertions are the whole test.

const WIDTHS = [320, 768, 1280] as const;
const SHOT_DIR = process.env.SWISS_LEGEND_SHOTS;

type Sport = { sport_key: string; variant_key: string; config: Record<string, unknown> };

/** The product's own sport. Every case that only READS the line uses it. */
const BADMINTON: Sport = { sport_key: "badminton", variant_key: "bwf", config: {} };
/** The case that must be PLAYED OUT uses `generic`/`score`, because a result
 *  can be posted over the API in one `generic.result` event — the same recipe
 *  `swiss-shell.spec.ts` uses to drive swiss rounds. The legend reads
 *  `stage.kind`, `stage.status`, `stage.config.rounds`, the roster and the row
 *  count; no part of it is sport-dependent, so this substitution costs the
 *  assertion nothing and saves a per-sport scoring rig. */
const GENERIC: Sport = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

type Case = {
  key: string;
  /** Entrants added before the page is read. Below two the division is never
   *  STARTED — a field that cannot be paired has nothing to generate, and that
   *  is exactly the brand-new stage an organiser meets first. */
  entrants: number;
  withdraw: number;
  rounds: number;
  sport?: Sport;
  /** Pair and decide every round, then POST /complete, before reading the
   *  line — so `stages.status` is written by the real endpoint rather than
   *  asserted about a row nothing produced. */
  play?: boolean;
  /** Withdrawals applied AFTER the stage completed: the post-event
   *  disqualification that used to rewrite a correct stage's line. */
  withdrawAfterPlay?: number;
  /** What the SCREEN must say, or `null` when the card must carry NO legend
   *  line at all. */
  expected: string | null;
};

const CASES: Case[] = [
  // ODD field: 11 → 5 matches + 1 bye. Rows agree (3 × 6 = 18).
  {
    key: "odd-11",
    entrants: 11,
    withdraw: 0,
    rounds: 3,
    expected: "3 rounds · 5 matches + 1 bye per round · 18 fixtures",
  },
  // EVEN field: 10 → 5 matches, NO bye clause at all.
  {
    key: "even-10",
    entrants: 10,
    withdraw: 0,
    rounds: 3,
    expected: "3 rounds · 5 matches per round · 15 fixtures",
  },
  // STALE: minted for 12 (6 a round, 18 rows), then 3 withdraw → field 9, which
  // needs 4 + a bye = 15. The rows still say 18. The legend prints the FIELD's
  // answer and the row count side by side; the disagreement is the signal.
  {
    key: "stale-12-minus-3",
    entrants: 12,
    withdraw: 3,
    rounds: 3,
    expected: "3 rounds · 4 matches + 1 bye per round · 18 fixtures",
  },
  // COMPLETE: 4 entrants over 2 rounds (2 matches a round, 4 rows), every
  // result in, stage completed through POST /stages/{id}/complete. Then ONE
  // entrant is withdrawn — the post-event disqualification. A live field of 3
  // would read "1 match + 1 bye per round", which describes nobody who played
  // and accuses a stage that was entirely correct. The finished line says only
  // what is still true.
  {
    key: "complete-4-then-withdraw-1",
    entrants: 4,
    withdraw: 0,
    rounds: 2,
    sport: GENERIC,
    play: true,
    withdrawAfterPlay: 1,
    expected: "2 rounds · 4 fixtures",
  },
  // EMPTY: the stage exists, nobody has signed up. This is the FIRST state an
  // organiser sees, and it used to read "3 rounds · 0 matches per round · 0
  // fixtures".
  { key: "empty-0", entrants: 0, withdraw: 0, rounds: 3, expected: null },
  // ONE entrant: 0 matches and a bye, which is no more meaningful than none.
  { key: "one-entrant", entrants: 1, withdraw: 0, rounds: 3, expected: null },
];

// Derived from the work, not a flat number (AGENTS.md #20): one division built
// through the API per case, the played case additionally pairing and deciding
// every round, then one page load per width. Moving either list — or the round
// count of the played case — moves the budget with it.
const caseCostMs = (c: Case) =>
  25_000 + // division + stage + entrants (+ start, + withdrawals)
  (c.play ? 20_000 + c.rounds * 20_000 : 0) + // /complete, and pair+decide a round
  WIDTHS.length * 20_000; // one page load and one read per width
const BUDGET_MS = 60_000 + CASES.reduce((ms, c) => ms + caseCostMs(c), 0);

type Fx = {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
};

test("swiss shape legend: odd, even, stale, complete and empty fields, at 320 / 768 / 1280", async ({
  page,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss legend ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const compId = comp.data!.id;

  // Read out of the live DOM, then asserted in one place at the end, so a
  // failure reports every width at once instead of stopping at the first.
  // `null` means "the card rendered and carried no legend line".
  const seen: Record<string, string | null> = {};
  const overflow: Record<string, number> = {};

  for (const c of CASES) {
    const sport = c.sport ?? BADMINTON;
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      { name: `${c.key} ${TAG}`, ...sport },
    );
    expect(div.status, `${c.key} division: ${JSON.stringify(div.error)}`).toBe(201);
    const divisionId = div.data!.id;

    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: c.rounds } },
    );
    expect(stage.status, `${c.key} stage: ${JSON.stringify(stage.error)}`).toBe(201);
    const stageId = stage.data!.id;

    let entrantIds: string[] = [];
    if (c.entrants > 0) {
      const added = await addEntrantsViaApi(
        request,
        divisionId,
        Array.from({ length: c.entrants }, (_, i) => `Player ${i + 1}`),
      );
      expect(added.ids, `${c.key} entrants`).toHaveLength(c.entrants);
      entrantIds = added.ids;
    }

    const fixturesOfStage = async (): Promise<Fx[]> => {
      const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
      return (all.data ?? []).filter((f) => f.stage_id === stageId);
    };

    // A field of fewer than two has nothing to pair, so it is never started —
    // which is precisely the state the `empty` and `one-entrant` cases exist to
    // photograph. Everything else starts: startDivision mints all-round shells
    // on the first stage, for the field as it stands RIGHT NOW, which is what
    // makes the stale case below possible.
    if (c.entrants >= 2) {
      const started = await apiJson<{ generated: number }>(
        request,
        `/api/v1/divisions/${divisionId}/start`,
        "POST",
      );
      expect(started.status, `${c.key} start: ${JSON.stringify(started.error)}`).toBe(200);
    }

    // A withdrawal is a status flip, not a delete: the row survives and drops
    // out of `status in ('registered','confirmed')`. The shells do not move.
    const withdraw = async (id: string, label: string) => {
      const res = await apiJson(request, `/api/v1/entrants/${id}`, "PATCH", {
        status: "withdrawn",
      });
      expect(res.status, `${label}: ${JSON.stringify(res.error)}`).toBe(200);
    };
    for (let i = 0; i < c.withdraw; i++) await withdraw(entrantIds[i]!, `${c.key} withdraw ${i}`);

    if (c.play) {
      // Pair each round, then post a result on every seated board. POST
      // /generate is what the organiser's own "Pair next round" control issues
      // (stage-rail.tsx `onAct(stage.id, "generate")`).
      for (let round = 1; round <= c.rounds; round++) {
        const paired = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
        expect(paired.status, `${c.key} pair r${round}: ${JSON.stringify(paired.error)}`).toBe(200);
        await expect
          .poll(
            async () =>
              (await fixturesOfStage())
                .filter((f) => f.round_no === round)
                .every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null),
            { message: `${c.key} r${round} seated`, timeout: 20_000 },
          )
          .toBe(true);

        for (const f of await fixturesOfStage()) {
          if (f.round_no !== round) continue;
          if (!f.home_entrant_id || !f.away_entrant_id) continue;
          if (["decided", "finalized"].includes(f.status)) continue;
          const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
          const ev = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
            expected_seq: st.data!.last_seq,
            type: "generic.result",
            payload: { p1Score: 2, p2Score: 0 },
          });
          expect(ev.status, `${c.key} r${round} result: ${JSON.stringify(ev.error)}`).toBe(201);
        }
      }

      const done = await apiJson<{ completed: boolean }>(
        request,
        `/api/v1/stages/${stageId}/complete`,
        "POST",
      );
      expect(done.status, `${c.key} complete: ${JSON.stringify(done.error)}`).toBe(200);
      // The gate this whole case rests on: the row really says `complete`. A
      // no-op completion would leave the stage `active` and this spec would be
      // asserting the LIVE arm while claiming to prove the finished one.
      expect(done.data!.completed, `${c.key}: the stage actually completed`).toBe(true);
    }

    for (let i = 0; i < (c.withdrawAfterPlay ?? 0); i++) {
      await withdraw(entrantIds[i]!, `${c.key} post-completion withdraw ${i}`);
    }

    const path = await divisionPath(request, divisionId, "?tab=fixtures");

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(path);

      // The POSITIVE anchor, and it is the legend's OWN PARENT. Asserting "no
      // legend" against a page that had not rendered the card yet would pass
      // for entirely the wrong reason (AGENTS.md #10's vacuous mode). Once this
      // header is on screen, the legend rendered into it or did not exist.
      const header = page.getByTestId("stage-sheet").first().locator("header").first();
      await expect(header, `${c.key}@${w}: the stage card header rendered`).toBeVisible({
        timeout: 30_000,
      });

      if (c.expected === null) {
        await expect(
          header.getByTestId("stage-swiss-legend"),
          `${c.key}@${w}: no legend line at all`,
        ).toHaveCount(0);
        seen[`${c.key}@${w}`] = null;
      } else {
        const legend = header.getByTestId("stage-swiss-legend").first();
        // toBeVisible, not toBeAttached: the point of this spec is that a
        // PERSON can read the line, and nothing folds it behind a disclosure.
        await expect(legend, `${c.key}@${w}: legend on screen`).toBeVisible({ timeout: 30_000 });
        seen[`${c.key}@${w}`] = (await legend.textContent())!.trim();
      }

      overflow[`${c.key}@${w}`] = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      if (SHOT_DIR) {
        const card = page.locator("section.card").first();
        await card.scrollIntoViewIfNeeded();
        const cb = (await card.boundingBox())!;
        await page.screenshot({
          path: `${SHOT_DIR}/swiss-legend-${c.key}-${w}.png`,
          clip: {
            x: Math.max(0, cb.x - 4),
            y: Math.max(0, cb.y - 4),
            width: Math.min(cb.width + 8, w),
            height: Math.min(cb.height + 8, 340),
          },
        });
      }
    }
  }

  // What the screen actually said, verbatim — the record a report quotes.
  console.log("SWISS LEGEND SEEN " + JSON.stringify(seen, null, 2));

  for (const c of CASES) {
    for (const w of WIDTHS) {
      const text = seen[`${c.key}@${w}`];
      expect(text, `${c.key}@${w}`).toBe(c.expected);
      if (text !== null) {
        // The bye clause is wholly ABSENT on an even field, not merely a
        // different number — a negative with its positive pair above.
        if (c.key === "even-10") expect(text, `${c.key}@${w}`).not.toContain("bye");
        // And on a FINISHED stage the whole per-round clause is gone, not
        // merely carrying a different figure. Its positive pair is every live
        // case above, each of which does contain both of these.
        if (c.play) {
          expect(text, `${c.key}@${w}`).not.toContain("match");
          expect(text, `${c.key}@${w}`).not.toContain("per round");
          expect(text, `${c.key}@${w}`).not.toContain("bye");
        }
      }
      expect(overflow[`${c.key}@${w}`], `${c.key}@${w}: horizontal page scroll`).toBeLessThanOrEqual(0);
    }
  }
});
