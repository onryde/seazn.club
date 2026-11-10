// W4 app PR B, Task 15 (T8-c, PR-B share): Q4a, "final not played -> joint winners" - the organiser's "Declare joint winners" on an unplayed
// final (route fixtures/[id]/joint-winners, B5a; RB4-C4, X-CH-4, X-CH-6) and its Undo. One opt-in script, W4B_Q4A, planned ONLY by
// `--set w1-driving --scenario W4B_Q4A` (w1-driving-set.ts, w4b-cells.ts). It reads the stored lines, the stage's placement rows and the
// completion's `places` and `title` (Task 3); each expectation is the rulebook's, never the product's answer.
//
// The declaration completes the stage whenever every other line is settled, so the two rows it runs on tell different halves of the story,
// and the Q4a script plays the half each row can read:
//   knockout              declare -> the stage completes with it (joint title, both finalists 1st) -> UNDO -> the final is open again, the stage
//                         re-opens -> the final is PLAYED -> the completion crowns one champion. The sequence (a second act after a withdrawal of the
//                         first) is the point: a declaration that cannot be undone, or leaves the final unplayable, is the defect.
//   knockout_third_place  declare -> the stage WAITS (its third-place line is still owed, RB4-C7) -> the third-place line is played -> the organiser's
//                         Complete answers the stage_completed event whose `title` is `joint` - the one place the title crosses the wire.
// Places (RB4-C4, and the engine's "standard competition ranking, with a rank shared - or left vacant"): both finalists rank 1st and NOBODY ranks 2nd.
import type { FixtureRow, JointWinnersOut, JointWinnersUndoOut, OrganiserDriver } from "../driver/types.ts";
import { DriverMisuse, RefusedCall } from "../driver/types.ts";
import { PENDING_STATUSES, crownOf, winnerOf, type CompleteObs, type ObservedPlace } from "../observed.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, finishStage, setUpDivision, snapshot, type StagePlay } from "./common.ts";
import { lineLoser, lineOf, type Line } from "./w4a-late-entry.ts";
import { Q4A_FIELD, finalOf, playOut, watchProductWrites } from "./w4b-support.ts";
import type { Scenario, ScenarioContext, ScenarioOutput } from "./types.ts";

/** A line with the two facts Q4a reads beyond the W4A `Line`: whether the product flags it the final, and the declaration's instant. */
export interface JLine extends Line { readonly isFinal: boolean; readonly jointAt: string | null }
export const jLineOf = (f: FixtureRow): JLine => ({ ...lineOf(f), isFinal: f.is_final === true, jointAt: f.joint_winners_at ?? null });

export type JointFlow = "undo" | "third_place";

export interface JointObs {
  readonly flow: JointFlow;
  /** The stage's lines after the semi-finals were played and before the declaration. */
  readonly before: readonly JLine[];
  readonly declared: JointWinnersOut | undefined;
  readonly afterDeclare: readonly JLine[];
  readonly stageAfterDeclare: string | undefined;
  /** The stage's placement rows right after the declaration (`rank` null: a row with none); null when the stage did not complete with it. */
  readonly rankRows: readonly { readonly entrantId: string; readonly rank: number | null }[] | null;
  /** The Undo (flow `undo` only): its answer, and the lines and stage status after it. */
  readonly undone: { readonly answer: JointWinnersUndoOut | undefined; readonly lines: readonly JLine[]; readonly stage: string | undefined } | null;
  /** The completion the script finally asked for, and the stage's lines after it. */
  readonly complete: CompleteObs | null;
  readonly finalLines: readonly JLine[];
}

const sameSeats = (a: Line, b: Line): boolean => a.home === b.home && a.away === b.away;
const seatsOf = (l: Line): string => `${l.home ?? "-"}/${l.away ?? "-"}`;
const holdersOf = (places: readonly ObservedPlace[], rank: number): string[] => places.filter((p) => p.rank === rank).map((p) => p.entrantId);

/** The Q4a items, every one counted. */
export function jointWinnersItems(o: JointObs): Item[] {
  const fin = finalOf(o.before);
  const items: Item[] = [{ ok: fin !== null, note: "the stage's lines name no final" }];
  if (fin === null || fin.home === null || fin.away === null) {
    if (fin !== null) items.push({ ok: false, note: `the final ${fin.id} seats ${seatsOf(fin)} - it needs both finalists before the declaration` });
    return items;
  }
  const finalists = [fin.home, fin.away].sort();
  items.push(
    { ok: PENDING_STATUSES.includes(fin.status) && fin.outcome === null, note: `the final reads ${fin.status}/${fin.outcome?.kind ?? "no outcome"} before the declaration, expected an unplayed final (RB4-C4: "final not played")` },
    { ok: (o.before.find((l) => l.id === fin.id) as JLine).jointAt === null, note: "the final carries a joint-winners instant before anything was declared" },
  );
  const d = o.declared;
  items.push({ ok: d !== undefined && d.fixture_id === fin.id, note: d === undefined ? "the declaration was refused or answered nothing" : `the declaration answers fixture ${d.fixture_id}, expected the final ${fin.id}` });
  if (d === undefined) return items;
  const after = o.afterDeclare.find((l) => l.id === fin.id);
  items.push(
    { ok: after !== undefined && after.status === "decided" && after.outcome === null, note: `after the declaration the final reads ${after?.status ?? "absent"}/${after?.outcome?.kind ?? "no outcome"}, expected decided with no outcome (V499)` },
    { ok: after !== undefined && after.jointAt !== null, note: "after the declaration the final carries no joint_winners_at" },
    { ok: after !== undefined && sameSeats(after, fin), note: `the final's seats moved on the declaration: ${seatsOf(fin)} -> ${after === undefined ? "gone" : seatsOf(after)}` },
  );
  // Nothing else in the bracket moved: one item per line the declaration had no business with.
  for (const b of o.before) {
    if (b.id === fin.id) continue;
    const x = o.afterDeclare.find((l) => l.id === b.id);
    items.push({ ok: x !== undefined && sameSeats(x, b) && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before the declaration, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after` });
  }
  const semiLosers = o.before.filter((l) => !l.thirdPlace && !l.isFinal).map(lineLoser).filter((x): x is string => x !== null);
  items.push({ ok: semiLosers.length === 2, note: `${semiLosers.length} semi-final loser(s) read off the lines, expected 2` });

  if (o.flow === "undo") {
    items.push(
      { ok: d.stage_completed === true, note: `the declaration answered stage_completed ${d.stage_completed}, expected true (a plain knockout has nothing else owed, RB4-C7)` },
      { ok: o.stageAfterDeclare === "complete", note: `the stage reads ${o.stageAfterDeclare ?? "absent"} after the declaration, expected complete` },
    );
    const rows = o.rankRows;
    items.push({ ok: rows !== null && rows.length > 0, note: "the stage's placement rows were never read after the declaration" });
    if (rows !== null && rows.length > 0) {
      for (const f of finalists) items.push({ ok: rows.find((r) => r.entrantId === f)?.rank === 1, note: `finalist ${f} ranks ${rows.find((r) => r.entrantId === f)?.rank ?? "nobody"} after the declaration, expected 1st (RB4-C4)` });
      items.push({ ok: rows.every((r) => r.rank !== 2), note: `${rows.filter((r) => r.rank === 2).length} entrant(s) rank 2nd after a joint title, expected nobody (competition ranking: 1, 1, 3, 3)` });
      for (const s of semiLosers) items.push({ ok: rows.find((r) => r.entrantId === s)?.rank === 3, note: `semi-final loser ${s} ranks ${rows.find((r) => r.entrantId === s)?.rank ?? "nobody"}, expected 3rd (Shared)` });
    }
    const u = o.undone;
    items.push({ ok: u !== null && u.answer !== undefined, note: "the Undo was refused or never asked" });
    if (u !== null && u.answer !== undefined) {
      const back = u.lines.find((l) => l.id === fin.id);
      items.push(
        { ok: u.answer.fixture_id === fin.id && u.answer.status === fin.status, note: `the Undo answers ${u.answer.fixture_id} ${u.answer.status}, expected the final ${fin.id} back to ${fin.status} (what it held)` },
        { ok: back !== undefined && back.status === fin.status && back.outcome === null && back.jointAt === null, note: `after the Undo the final reads ${back?.status ?? "absent"}/${back?.outcome?.kind ?? "no outcome"}, jointAt ${back?.jointAt ?? "none"} - expected ${fin.status} with none` },
        { ok: u.stage !== "complete", note: `after the Undo the stage still reads ${u.stage ?? "absent"} - the declaration's completion must re-open` },
      );
      for (const b of o.before) {
        if (b.id === fin.id) continue;
        const x = u.lines.find((l) => l.id === b.id);
        items.push({ ok: x !== undefined && sameSeats(x, b) && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after the Undo` });
      }
    }
    // The second act: the final was PLAYED after the Undo and the stage completed on a champion.
    const played = o.finalLines.find((l) => l.id === fin.id);
    const champion = played === undefined ? null : winnerOf(played.outcome);
    const places = o.complete?.places ?? null;
    items.push({ ok: champion !== null && finalists.includes(champion), note: `after the Undo the replayed final reads ${played?.status ?? "absent"}/${played?.outcome?.kind ?? "no outcome"}, expected a winner among ${finalists.join(", ")}` });
    const crown = crownOf(o.complete);
    items.push(
      { ok: crown.kind === "champion" && crown.ids[0] === champion, note: `the completion after the replay crowns ${crown.kind}${crown.ids.length > 0 ? ` (${crown.ids.join(", ")})` : ""}, expected the champion ${champion ?? "(none)"}` },
      { ok: places !== null && champion !== null && holdersOf(places, 1).length === 1 && holdersOf(places, 1)[0] === champion, note: `places after the replay rank ${places === null ? "nobody" : holdersOf(places, 1).join(", ") || "nobody"} 1st, expected only ${champion ?? "(none)"}` },
    );
    return items;
  }

  // flow third_place: the declaration waits for the third-place line.
  const third = o.before.find((l) => l.thirdPlace);
  items.push(
    { ok: third !== undefined, note: "the Play-off row's bracket holds no third-place line" },
    { ok: d.stage_completed === false, note: `the declaration answered stage_completed ${d.stage_completed}, expected false (the third-place line is still owed, RB4-C7)` },
    { ok: o.stageAfterDeclare !== "complete", note: `the stage reads ${o.stageAfterDeclare ?? "absent"} after the declaration, expected it to WAIT for the third-place line` },
  );
  const thirdAfter = third === undefined ? undefined : o.afterDeclare.find((l) => l.id === third.id);
  items.push({ ok: thirdAfter !== undefined && PENDING_STATUSES.includes(thirdAfter.status), note: `the third-place line reads ${thirdAfter?.status ?? "absent"} after the declaration, expected it still owed` });
  const crown = crownOf(o.complete);
  const places = o.complete?.places ?? null;
  items.push(
    { ok: o.complete?.completed === true, note: "the organiser's Complete after the third-place line did not complete the stage" },
    { ok: crown.kind === "joint" && [...crown.ids].sort().join() === finalists.join(), note: `the completion's title is ${crown.kind}${crown.ids.length > 0 ? ` (${crown.ids.join(", ")})` : ""}, expected joint winners ${finalists.join(" and ")}` },
    { ok: places !== null && JSON.stringify(holdersOf(places, 1).sort()) === JSON.stringify(finalists), note: `places rank ${places === null ? "nobody" : holdersOf(places, 1).join(", ") || "nobody"} 1st, expected both finalists ${finalists.join(" and ")}` },
    { ok: places !== null && holdersOf(places, 2).length === 0, note: `${places === null ? 0 : holdersOf(places, 2).length} entrant(s) rank 2nd after a joint title, expected nobody` },
  );
  const t = third === undefined ? undefined : o.finalLines.find((l) => l.id === third.id);
  const w = t === undefined ? null : winnerOf(t.outcome);
  const l = t === undefined || w === null ? null : t.home === w ? t.away : t.home;
  items.push({ ok: w !== null && l !== null, note: `the third-place line reads ${t?.status ?? "absent"}/${t?.outcome?.kind ?? "no outcome"} after play, expected a winner` });
  if (places !== null && w !== null && l !== null) {
    items.push(
      { ok: places.find((p) => p.entrantId === w)?.rank === 3, note: `the third-place winner ${w} ranks ${places.find((p) => p.entrantId === w)?.rank ?? "nobody"}, expected 3rd` },
      { ok: places.find((p) => p.entrantId === l)?.rank === 4, note: `the third-place loser ${l} ranks ${places.find((p) => p.entrantId === l)?.rank ?? "nobody"}, expected 4th` },
    );
  }
  return items;
}

/** The two optional acts the script needs: the HTTP driver has them, a layer that does not drive the path (the browser's, the fakes) does not. A guard, not a
 *  cast: the narrowed `const` keeps its type inside the closures, and the calls stay METHOD calls. */
function drivesJointWinners(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "declareJointWinners" | "undoJointWinners">> {
  return d.declareJointWinners !== undefined && d.undoJointWinners !== undefined;
}

/** A scripted driver call the product may refuse: the refusal is the run's finding, so it is returned, never thrown. */
async function attempt<T>(rec: Recorder, what: string, call: () => Promise<T>): Promise<T | RefusedCall> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.notes.push(`${what} refused ${e.status} ${e.code ?? "(no code)"}`);
    return e;
  }
}

async function q4aRun(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const rec = new Recorder();
  const setup = await setUpDivision(ctx, rec, Q4A_FIELD);
  const d = ctx.driver;
  if (!drivesJointWinners(d)) throw new DriverMisuse("driver: W4B_Q4A needs declareJointWinners and undoJointWinners - the HTTP driver has them, a layer that does not drive the path says so");
  const stage = setup.stage;
  const flow: JointFlow = ctx.spec.row === "knockout_third_place" ? "third_place" : "undo";
  const linesOf = async (): Promise<JLine[]> => (await d.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id).map(jLineOf);
  const statusOf = async (): Promise<string | undefined> => (await d.listStages(setup.division.id)).find((s) => s.id === stage.id)?.status;
  // The semi-finals only: the final (and a third-place line) stay unplayed.
  await playOut(ctx, rec, setup, stage, (f) => f.is_final !== true && f.third_place !== true);
  const before = await linesOf();
  const final = finalOf(before);
  if (final === null) throw new Error(`scenario: stage ${stage.id} has no final among its ${before.length} lines`);
  const declared = await watchProductWrites(ctx, rec, setup, "the joint-winners declaration", () => attempt(rec, "the declaration", () => d.declareJointWinners(final.id)));
  const afterDeclare = await linesOf();
  const stageAfterDeclare = await statusOf();
  let rankRows: JointObs["rankRows"] = null;
  let undone: JointObs["undone"] = null;
  if (flow === "undo") {
    if (!(declared instanceof RefusedCall) && declared.stage_completed) rankRows = (await d.standings(stage.id, null)).rows.map((r) => ({ entrantId: r.entrantId, rank: r.rank }));
    const answer = await attempt(rec, "the Undo", () => d.undoJointWinners(final.id));
    undone = { answer: answer instanceof RefusedCall ? undefined : answer, lines: await linesOf(), stage: await statusOf() };
    // The second act: the final is open again, so it is played like any other line.
    await playOut(ctx, rec, setup, stage);
  } else {
    // The third-place line (the stage's last owed line) is played, then the organiser's Complete reads the joint title.
    await playOut(ctx, rec, setup, stage);
  }
  const open = (await linesOf()).filter((l) => l.status !== "decided" && l.status !== "finalized" && l.status !== "forfeited" && l.status !== "cancelled" && l.status !== "abandoned");
  if (open.length === 0) { rec.track(stage.id).exit = "drained"; rec.exit = "drained"; }
  const complete = await finishStage(ctx, rec, stage.id);
  const plays: StagePlay[] = [{ stage, field: setup.entrants.map((e) => e.id), advance: null, complete }];
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
  const obs: JointObs = {
    flow, before, declared: declared instanceof RefusedCall ? undefined : declared, afterDeclare, stageAfterDeclare, rankRows, undone,
    complete, finalLines: await linesOf(),
  };
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), assertion("w4b-q4a-joint-winners", jointWinnersItems(obs)), stageCompleted(observed), loopBounded(rec, observed), lineupsPut(rec, setup)],
  };
}

export const q4aScenarios: Readonly<Record<"W4B_Q4A", Scenario>> = Object.freeze({ W4B_Q4A: { key: "W4B_Q4A", entrantCount: Q4A_FIELD, canaryCheck: null, run: q4aRun } });
