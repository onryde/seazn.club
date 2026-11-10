// W4 app PR B, Task 15 (T8-c, PR-B share): Q3, "third-place match skipped -> shared 3rd", as two opt-in scripts - W4B_Q3 on the lone
// knockout in BOTH of its Third place settings (the `knockout` row is Shared, the `knockout_third_place` row is Play-off; X-TP-1,
// X-TP-2) and W4B_Q3_OUT, the Play-off whose two semi-final losers are both out. Planned ONLY by `--set w1-driving --scenario <key>`
// (w1-driving-set.ts, w4b-cells.ts), as W2a's, W2b's, W2e's and W4A's are, so no committed plan holds one.
//
// Each script plays the division through the standard tail (playDivision) so the run is also judged by the invariants and the shared
// life checks; its OWN check is a pure function of what the script read (`thirdPlaceItems`), which counts every item it examined - an
// empty set is a failure (R25), never a pass. The expected values are the RULEBOOK's (rulebook-W4-knockout.md), never the product's
// answer, and the fixtures a script reads (who lost a semi-final, who won the final) are read off the stored lines, never assumed:
//   RB4-T2   Shared: both semi-final losers rank 3rd, and nobody ranks 4th (ruling 270: two bronzes);
//   RB4-T3   Play-off: the two semi-final losers play for 3rd and 4th; the winner is 3rd, the loser 4th;
//   RB4-T6   a play-off whose two sides are both out: 3rd is vacant and both rank 4th (X-TP-7: a departure double walkover).
// Where it is read: the completion's `places` and `title` (Task 3), the PUBLIC standings' ranks, and - in a browser layer - the banner
// (browser-driver.ts #championWant reads the title). The finalists are the rows' own, so a seed order cannot stand in for a result.
import type { FixtureRow } from "../driver/types.ts";
import { DEPARTED_STATUSES, crownOf, winnerOf, type CompleteObs, type ObservedOutcome, type ObservedPlace } from "../observed.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, finishStage, playDivision, setUpDivision, snapshot } from "./common.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { lineLoser, lineOf, type Line } from "./w4a-late-entry.ts";
import { Q3_FIELD, Q3_OUT_FIELD, finalOf, rankOf, playOut, watchProductWrites, type Q3Key } from "./w4b-support.ts";
import type { Scenario, ScenarioContext, ScenarioOutput } from "./types.ts";

export type ThirdPlaceMode = "shared" | "playoff";

export interface Q3Obs {
  /** The setting the row's stage was POSTED with (config.thirdPlace === true is Play-off, else Shared; thirdPlaceModeOf). */
  readonly mode: ThirdPlaceMode;
  /** The setting the rulebook says the row carries (`knockout` Shared, `knockout_third_place` Play-off) - a guard on the row's own body. */
  readonly rowMode: ThirdPlaceMode;
  /** The stage's entrants, as the division seated them. */
  readonly field: readonly string[];
  /** The stage's fixtures once it completed. */
  readonly lines: readonly Line[];
  readonly complete: CompleteObs | null;
  /** The PUBLIC standings' rank of each entrant of the stage's table (null: a row with no rank), or null when it was not read. */
  readonly publicRanks: ReadonlyMap<string, number | null> | null;
  /** Entrants the product stores as departed. */
  readonly departed: ReadonlySet<string>;
}

const ranksOf = (places: readonly ObservedPlace[], rank: number): string[] => places.filter((p) => p.rank === rank).map((p) => p.entrantId);

/** The place an entrant's 3p result (a win, an award or a double walkover) gives each side: [winnerRank, loserRank], or null for a result
 *  that places nobody apart. A double walkover places BOTH 4th (RB4-T6). */
function playoffRanks(o: ObservedOutcome | null): { winner: number | null; loser: number | null; both: number | null } | null {
  if (o === null) return null;
  if (o.kind === "double_walkover") return { winner: null, loser: null, both: 4 };
  if (winnerOf(o) === null) return null;
  return { winner: 3, loser: 4, both: null };
}

/** The Q3 items, every one counted. */
export function thirdPlaceItems(o: Q3Obs): Item[] {
  const items: Item[] = [{ ok: o.mode === o.rowMode, note: `the row's stage was posted ${o.mode}, the rulebook's row carries ${o.rowMode} (X-TP-2)` }];
  const places = o.complete?.places ?? null;
  items.push({ ok: places !== null && places.length > 0, note: o.complete === null ? "the stage's completion was never read" : "the completion answered no places (Task 3)" });
  if (places === null || places.length === 0) return items;
  // The product's two lists agree: finalRanks is the places' entrants, in order.
  items.push({ ok: o.complete?.finalRanks !== null && JSON.stringify(o.complete?.finalRanks) === JSON.stringify(places.map((p) => p.entrantId)), note: `finalRanks ${JSON.stringify(o.complete?.finalRanks ?? null)} is not the places' entrants in order ${JSON.stringify(places.map((p) => p.entrantId))}` });
  // Every entrant of the stage holds exactly one place; nobody else does.
  for (const e of o.field) {
    const n = places.filter((p) => p.entrantId === e).length;
    items.push({ ok: n === 1, note: `${e} holds ${n} place(s), expected exactly 1` });
  }
  items.push({ ok: places.length === o.field.length, note: `${places.length} places for a field of ${o.field.length}` });
  const fin = finalOf(o.lines);
  const champion = fin === null ? null : winnerOf(fin.outcome);
  const runnerUp = fin === null || champion === null ? null : fin.home === champion ? fin.away : fin.home;
  items.push({ ok: fin !== null && champion !== null && runnerUp !== null, note: "the final is not decided with a winner, so the champion cannot be read off the lines" });
  const semis = o.lines.filter((l) => !l.thirdPlace && fin !== null && l.round === (fin.round ?? 0) - 1);
  const losers = semis.map(lineLoser);
  items.push({ ok: semis.length === 2 && losers.every((x) => x !== null), note: `${semis.length} semi-final(s) read, ${losers.filter((x) => x !== null).length} with a loser - expected 2 decided` });
  if (fin === null || champion === null || runnerUp === null || semis.length !== 2 || losers.some((x) => x === null)) return items;
  const [s1, s2] = losers as [string, string];
  const rank = (e: string) => rankOf(places, e);
  items.push(
    { ok: rank(champion) === 1, note: `the champion ${champion} ranks ${rank(champion) ?? "nobody"}, expected 1st` },
    { ok: rank(runnerUp) === 2, note: `the runner-up ${runnerUp} ranks ${rank(runnerUp) ?? "nobody"}, expected 2nd` },
    { ok: ranksOf(places, 1).length === 1, note: `${ranksOf(places, 1).length} entrants rank 1st, expected exactly 1 (RB4-C1)` },
  );
  const title = crownOf(o.complete);
  items.push({ ok: title.kind === "champion" && title.ids[0] === champion, note: `the completion's title is ${title.kind}${title.ids.length > 0 ? ` (${title.ids.join(", ")})` : ""}, expected the champion ${champion}` });
  const thirds = o.lines.filter((l) => l.thirdPlace);
  if (o.mode === "shared") {
    items.push(
      { ok: thirds.length === 0, note: `${thirds.length} third-place line(s) exist under Shared, expected none` },
      { ok: rank(s1) === 3 && rank(s2) === 3, note: `the semi-final losers rank ${rank(s1) ?? "nobody"} and ${rank(s2) ?? "nobody"}, expected both 3rd (RB4-T2: two bronzes)` },
      { ok: ranksOf(places, 4).length === 0, note: `${ranksOf(places, 4).length} entrant(s) rank 4th under Shared, expected nobody (RB4-T2)` },
    );
  } else {
    const t = thirds[0];
    items.push({ ok: thirds.length === 1, note: `${thirds.length} third-place line(s) exist under Play-off, expected exactly 1 (RB4-T3)` });
    if (t !== undefined) {
      const seats = [t.home, t.away].filter((x): x is string => x !== null);
      // Who plays whom: the two semi-final losers (RB4-T3). A seat the product cleared (a departed side) is read as missing, never as a match.
      // Under a double walkover the product may seat both departed sides or clear them: any seat it keeps must still be a semi-final loser.
      const bothOut = t.outcome?.kind === "double_walkover";
      items.push({ ok: seats.every((x) => x === s1 || x === s2) && (bothOut || (seats.length === 2 && new Set(seats).size === 2)), note: `the third-place line seats ${seats.join(" v ") || "nobody"}, expected the semi-final losers ${s1} and ${s2}` });
      const r = playoffRanks(t.outcome);
      items.push({ ok: r !== null, note: `the third-place line reads ${t.status}/${t.outcome?.kind ?? "no outcome"} - no result that places anybody (RB4-T3: the stage is not complete until it is decided)` });
      if (r !== null && r.both !== null) {
        items.push(
          { ok: ranksOf(places, 3).length === 0, note: `${ranksOf(places, 3).length} entrant(s) rank 3rd after a third-place double walkover, expected nobody (RB4-T6: 3rd is vacant)` },
          { ok: rank(s1) === 4 && rank(s2) === 4, note: `the semi-final losers rank ${rank(s1) ?? "nobody"} and ${rank(s2) ?? "nobody"}, expected both 4th (RB4-T6)` },
          { ok: o.departed.has(s1) && o.departed.has(s2), note: `a third-place double walkover needs both sides departed; the product stores ${[s1, s2].filter((x) => !o.departed.has(x)).join(", ") || "both"} as still in` },
        );
      } else if (r !== null) {
        const w = winnerOf(t.outcome)!;
        const l = w === t.home ? t.away : t.home;
        items.push(
          { ok: rank(w) === 3, note: `the third-place winner ${w} ranks ${rank(w) ?? "nobody"}, expected 3rd` },
          { ok: l !== null && rank(l) === 4, note: `the third-place loser ${l ?? "(none)"} ranks ${l === null ? "nobody" : (rank(l) ?? "nobody")}, expected 4th` },
          { ok: ranksOf(places, 3).length === 1 && ranksOf(places, 4).length === 1, note: `${ranksOf(places, 3).length} entrant(s) rank 3rd and ${ranksOf(places, 4).length} 4th, expected exactly one each (RB4-T3)` },
        );
      }
    }
  }
  // The rest of the field sits below the top four, and the list never ranks a later entrant above an earlier one.
  const topFour = new Set([champion, runnerUp, s1, s2]);
  for (const p of places.filter((x) => !topFour.has(x.entrantId))) items.push({ ok: p.rank >= 5, note: `${p.entrantId} (out before the semi-finals) ranks ${p.rank}, expected below 4th` });
  items.push({ ok: places.every((p, i) => i === 0 || p.rank >= places[i - 1].rank), note: `places are not in rank order: ${places.map((p) => p.rank).join(",")}` });
  // The public standings carry the same ranks (RB4-T2: "every surface"). Read for the top four.
  if (o.publicRanks === null) items.push({ ok: false, note: "the public standings were never read" });
  else for (const e of topFour) items.push({ ok: o.publicRanks.get(e) === rank(e), note: `the public standings rank ${e} ${o.publicRanks.get(e) ?? "(no row)"}, the completion's places say ${rank(e) ?? "nobody"}` });
  return items;
}

/** The setting a stage body was posted with: only `config.thirdPlace === true` is Play-off (third-place.ts thirdPlaceModeOf). */
export const modeOfBody = (config: Readonly<Record<string, unknown>> | undefined): ThirdPlaceMode => (config?.thirdPlace === true ? "playoff" : "shared");

/** The rulebook's setting of each row this script plays (RB4-T1: Shared is the default; the `knockout_third_place` row is the Play-off). */
export const ROW_MODE: Readonly<Record<string, ThirdPlaceMode>> = Object.freeze({ knockout: "shared", knockout_third_place: "playoff" });

async function q3Run(ctx: ScenarioContext, key: Q3Key): Promise<ScenarioOutput> {
  const rec = new Recorder();
  const out = key === "W4B_Q3_OUT";
  const setup = await setUpDivision(ctx, rec, out ? Q3_OUT_FIELD : Q3_FIELD);
  if (out) {
    // Both semi-final sides that will lose are withdrawn before a ball is kicked: seeds 3 and 4 of a bracket of four, so seed 1 and 2 are
    // walked over into the final and the third-place line seats two departed sides (a DEPARTURE double walkover, ruling 270's M-1).
    for (const seed of [3, 4]) {
      const id = setup.idOfSeed(seed);
      const w = await watchProductWrites(ctx, rec, setup, `the withdrawal of seed ${seed}`, () => ctx.driver.withdraw(id));
      rec.facts.add("withdrawn");
      rec.withdrawn.add(id);
      rec.notes.push(`withdrawal of seed ${seed}: policy ${w.policy}, ${w.walkovers} walkover(s)`);
    }
  }
  let plays: Awaited<ReturnType<typeof playDivision>>;
  if (out) {
    // With the field down to two, the product refuses a RE-generate (KO_THIRD_PLACE_TOO_FEW: its entrant count is the ACTIVE field), which the play loop
    // would read as a stuck stage. The organiser's screen never asks again: the bracket was drawn at Start, so the open final is decided and the stage
    // completed directly (the refusal stays in the notes, below, as a product observation).
    await playOut(ctx, rec, setup, setup.stage);
    rec.track(setup.stage.id).exit = "drained";
    rec.exit = "drained";
    plays = [{ stage: setup.stage, field: setup.entrants.map((e) => e.id), advance: null, complete: await finishStage(ctx, rec, setup.stage.id) }];
  } else {
    plays = await playDivision(ctx, rec, setup);
  }
  for (const g of rec.generates.filter((x) => x.status !== 200)) rec.notes.push(`generate refused ${g.status} ${g.code ?? "(no code)"}: ${g.message ?? ""}`);
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
  const stageId = setup.stage.id;
  const lines = (await ctx.driver.listFixtures(setup.division.id)).filter((f: FixtureRow) => f.stage_id === stageId).map(lineOf);
  const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
  const pubRows = pub.standings.find((s) => s.stage_id === stageId)?.rows ?? null;
  const departed = new Set((await ctx.driver.listEntrants(setup.division.id)).filter((e) => DEPARTED_STATUSES.includes(e.status)).map((e) => e.id));
  const body = setup.built.posted.stages.find((b) => b.seq === setup.stage.seq);
  const obs: Q3Obs = {
    mode: modeOfBody(body?.config), rowMode: out ? "playoff" : (ROW_MODE[ctx.spec.row] ?? "shared"),
    field: setup.entrants.map((e) => e.id), lines, complete: plays[0]?.complete ?? null,
    publicRanks: pubRows === null ? null : new Map(pubRows.map((r) => [r.entrantId, r.rank])), departed,
  };
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), assertion(out ? "w4b-q3-third-place-both-out" : "w4b-q3-third-place", thirdPlaceItems(obs)), stageCompleted(observed), loopBounded(rec, observed), advanceSeededAsDeclared(plays, observed, rec.withdrawn), lineupsPut(rec, setup)],
  };
}

const q3 = (key: Q3Key, entrantCount: number): Scenario => ({ key, entrantCount, canaryCheck: null, run: (ctx) => q3Run(ctx, key) });

export const q3Scenarios: Readonly<Record<Q3Key, Scenario>> = Object.freeze({ W4B_Q3: q3("W4B_Q3", Q3_FIELD), W4B_Q3_OUT: q3("W4B_Q3_OUT", Q3_OUT_FIELD) });
