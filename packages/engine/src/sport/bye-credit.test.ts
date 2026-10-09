// C-5 (spec §5.1, "exactly today's bye delta"). A bye is an `award` nobody forfeited: four server writers emit it with
// no event, and `awardByeDelta` (apps/web engine-db/competition.ts) folds it through the module's own `standingsDelta`
// against a PHANTOM opponent on an `init` state. W2b gives `award` a typed `reason` and a per-sport `forfeitCredit`, so
// a walkover now credits goals and sets — and a bye must NOT. This file pins the bye delta per sport.
//
// THE ONE PLACE A TEST HERE READS ITS EXPECTED VALUE FROM CODE, and the spec orders it: "`forfeitCredit(…, "bye")`
// returns exactly today's bye delta". `__fixtures__/bye-deltas.json` was written by this file's own writer
// (`W2B_BYE_SNAPSHOT=1`) on the tree BEFORE any W2b module change (preflight C19: on c7a7557ac, engine identical to
// main a99147bd0), and is committed alone so the diff that made it is reviewable as "no module moved".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "bye-deltas.json");
/** awardByeDelta's phantom seat (apps/web engine-db/competition.ts `BYE_PHANTOM`). */
const BYE_PHANTOM = "__bye__";
const WINNER = "W";
const SEATS = ["home", "away"] as const;

type Snapshot = Record<string, Record<string, Record<(typeof SEATS)[number], [StandingsDelta, StandingsDelta]>>>;

/** Every sport × every declared cfg × the winner seated home and away, exactly as `awardByeDelta` builds it: an
 *  `init` state with the phantom opposite the winner, stage ctx swiss (the commonest bye), outcome a bye award. The
 *  outcome carries W2b's `loser: null, reason: "bye"`; the pre-W2b modules read only `winner`, so the same call
 *  is valid on both sides of the change. */
const W2B_BYE = { kind: "award", winner: WINNER, loser: null, reason: "bye" };
/** The award the server's bye writers built before W2b: a winner and nothing else (no `loser`, no `reason`). */
const LEGACY_BYE = { kind: "award", winner: WINNER };

function byeDeltas(award: Record<string, unknown> = W2B_BYE): { snap: Snapshot; checked: number } {
  const snap: Snapshot = {};
  let checked = 0;
  forEachSport(({ key, module: m }) => {
    snap[key] = {};
    for (const { name, cfg } of declaredCfgs(m as never)) {
      const perSeat = {} as Record<(typeof SEATS)[number], [StandingsDelta, StandingsDelta]>;
      for (const seat of SEATS) {
        const state = m.init(cfg, {
          home: { entrantId: seat === "home" ? WINNER : BYE_PHANTOM, slots: [] },
          away: { entrantId: seat === "home" ? BYE_PHANTOM : WINNER, slots: [] },
        });
        const outcome = award as never;
        perSeat[seat] = m.standingsDelta(outcome, cfg, { kind: "swiss" }, state);
        checked++;
      }
      snap[key][name] = perSeat;
    }
  });
  return { snap, checked };
}

describe("C-5: a bye credits exactly today's bye delta, per sport (spec §5.1)", () => {
  if (process.env.W2B_BYE_SNAPSHOT === "1") {
    it("writes the snapshot (W2B_BYE_SNAPSHOT=1, run once on the pre-W2b tree)", () => {
      const { snap, checked } = byeDeltas();
      expect(checked).toBeGreaterThan(0);
      writeFileSync(FIXTURE, `${JSON.stringify(snap, null, 2)}\n`);
    });
    return;
  }

  it("C-5: empty case first — the snapshot exists, names all 11 sports, and holds at least one cfg per sport", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
    expect(Object.keys(snap)).toHaveLength(11);
    for (const [key, cfgs] of Object.entries(snap)) expect(Object.keys(cfgs).length, key).toBeGreaterThan(0);
  });

  it("C-5: standingsDelta(award{loser:null, reason:\"bye\"}) equals the pre-W2b bye delta for every sport, cfg and seat", () => {
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
    const { snap: now, checked } = byeDeltas();
    let compared = 0;
    for (const [key, cfgs] of Object.entries(snap)) {
      for (const [name, seats] of Object.entries(cfgs)) {
        for (const seat of SEATS) {
          expect(now[key]?.[name]?.[seat], `${key}/${name}/${seat}`).toEqual(seats[seat]);
          compared++;
        }
      }
    }
    expect(compared).toBe(checked); // no sport, cfg or seat appeared or vanished since the snapshot
    expect(compared).toBeGreaterThanOrEqual(11 * 2);
  });

  it("C-5: a legacy award with no reason and no loser (a bye written before W2b) ranks as the same bye delta", () => {
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
    const { snap: now, checked } = byeDeltas(LEGACY_BYE);
    let compared = 0;
    for (const [key, cfgs] of Object.entries(snap)) {
      for (const [name, seats] of Object.entries(cfgs)) {
        for (const seat of SEATS) {
          expect(now[key]?.[name]?.[seat], `${key}/${name}/${seat}`).toEqual(seats[seat]);
          compared++;
        }
      }
    }
    expect(compared).toBe(checked);
    expect(compared).toBeGreaterThanOrEqual(11 * 2);
  });
});
