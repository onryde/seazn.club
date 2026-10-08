// Scenario assertions. Every one goes through `assertion`, so R25 holds for
// them exactly as it does for the invariants: zero items checked is a FAIL,
// and only a stated reason may abstain.
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import type { PublicStandingsOut, StageRef } from "../driver/types.ts";
import { cascadeWrote, isBye, isNamedRefusal, isTerminal, sameOutcome, type ConfigEditObs, type ObservedOutcome, type ObservedRun, type ObservedStage } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import { judgeDrive } from "../reference-bracket.ts";
import { resolveSportCfg } from "../sport-cfg.ts";
import type { BuiltReadback, DivisionSetup, Recorder } from "./common.ts";
import { lineupItems } from "./lineup-plan.ts";

export interface Item { ok: boolean; note: string }

/** m-1: the prefix on a canary's deliberately WRONG expectation. */
export const CANARY_MARK = "canary (deliberately wrong): ";

/** m-1: a scenario's own check in a canary run carries its right-answer items
 *  FIRST and then the deliberately wrong ones, each note marked. run.ts
 *  (canaryVerdict) accepts the canary only when that check is the one failure
 *  and every failing line is marked: the right answer held, and only the
 *  wrong expectation failed. Right items first also means an unmarked failure
 *  is never pushed past the evidence cap by marked ones. Outside a canary run
 *  only the right items are asserted. */
export function withCanary(right: readonly Item[], wrong: readonly Item[], canary: boolean): Item[] {
  return canary ? [...right, ...wrong.map((i) => ({ ok: i.ok, note: `${CANARY_MARK}${i.note}` }))] : [...right];
}

export function assertion(id: string, items: readonly Item[], abstainReason: string | null = null): CheckResult {
  if (abstainReason !== null) return { id, kind: "assertion", verdict: "abstain", checked: 0, reason: abstainReason, evidence: [] };
  if (items.length === 0) return { id, kind: "assertion", verdict: "fail", checked: 0, reason: "checked 0 items (vacuous, R25)", evidence: [] };
  const bad = items.filter((i) => !i.ok).map((i) => i.note);
  return { id, kind: "assertion", verdict: bad.length > 0 ? "fail" : "pass", checked: items.length, reason: bad[0] ?? `${items.length} ok`, evidence: bad.slice(0, 12) };
}

/** Key-sorted JSON: a config value read back with its keys reordered is the same value. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x)) ?? "undefined";
}

/** W1-driving Task 8: whether a stage's fixtures seat an entrant — directly,
 *  or, on an americano stage (which seats the pair entrants it mints, never
 *  the division's), through a person: one of the entrant's persons is a
 *  member of some seated side (ObservedStage.persons). On every other kind
 *  `persons` is absent and only a direct seat counts. */
export function seatsEntrant(stage: Pick<ObservedStage, "fixtures" | "persons">): (entrantId: string) => boolean {
  const sides = new Set(stage.fixtures.flatMap((f) => [f.home, f.away]).filter((e): e is string => e !== null));
  const persons = stage.persons ?? {};
  const seatedPersons = new Set([...sides].flatMap((e) => persons[e] ?? []));
  return (entrantId) => sides.has(entrantId) || (persons[entrantId] ?? []).some((p) => seatedPersons.has(p));
}

/** Final review I-2: the product built what the harness POSTED. Every item is
 *  derived from the posted bodies, never a typed table: the division's sport
 *  and variant; one stage per body, of the body's kind, with every config key
 *  the body set reading back equal (keys the server adds are not judged); and
 *  every posted entrant stored exactly once and seated in some fixture of the
 *  stage. Without it a knockout body built as a league, a dropped config key
 *  or 7 of 8 entrants seated is judged against the product's own description. */
export function builtAsPosted(built: BuiltReadback, observed: ObservedRun): CheckResult {
  const { posted, division } = built;
  const items: Item[] = [
    { ok: division.sportKey === posted.sport, note: `division sport ${division.sportKey}, posted ${posted.sport}` },
    { ok: division.variantKey === posted.variant, note: `division variant ${division.variantKey}, posted ${posted.variant}` },
  ];
  // W1b Task 10: one item per overridden key. The product stores the PARSED
  // preset + override (divisions.ts createDivision), so the expected value is
  // the engine's own parse of it, never the raw override — a partly overridden
  // nested object comes back filled by the schema.
  const overridden = Object.keys(posted.config);
  if (overridden.length > 0) {
    const expected = resolveSportCfg(posted.sport, posted.variant, { ...posted.config }) as Record<string, unknown>;
    for (const k of overridden) {
      items.push({ ok: canonical(division.config[k]) === canonical(expected[k]), note: `division config.${k}: built ${canonical(division.config[k])}, the engine resolves ${canonical(expected[k])}` });
    }
  }
  items.push({ ok: built.stages.length === posted.stages.length, note: `${built.stages.length} stage(s) built, ${posted.stages.length} posted` });
  for (const body of posted.stages) {
    const s = built.stages.find((x) => x.seq === body.seq);
    items.push({ ok: s?.kind === body.kind, note: `stage ${body.seq}: built ${s?.kind ?? "nothing"}, posted ${body.kind}` });
    for (const [k, v] of Object.entries(body.config)) {
      const got = s === undefined ? undefined : s.config[k];
      items.push({ ok: s !== undefined && canonical(got) === canonical(v), note: `stage ${body.seq} config.${k}: built ${canonical(got)}, posted ${canonical(v)}` });
    }
    // T3 review G1: the stored config.thirdPlace (judged just above) says
    // nothing about the bracket. A knockout posted with it must BUILD exactly
    // one third-place match, or knockout_third_place reads as a plain knockout;
    // and (fix round 1, m-4) one posted without it must build none, or a
    // product that mints the match unasked passes both rows.
    if (body.kind === "knockout") {
      const asked = body.config.thirdPlace === true;
      const fixtures = observed.stages.find((o) => s !== undefined && o.id === s.id)?.fixtures ?? [];
      const n = fixtures.filter((f) => f.thirdPlace === true).length;
      items.push({ ok: n === (asked ? 1 : 0), note: `stage ${body.seq}: posted ${asked ? "" : "no "}thirdPlace, built ${n} third-place fixture(s)` });
    }
  }
  // W1-driving Task 8: Start's generate on an americano stage mints `pair`
  // entrants (stages.ts pairEntrantsFor), and the entrant list carries them
  // (entrants.ts listEntrants has no kind filter). They are the PRODUCT's,
  // never posted (the harness refuses a pair-kind americano division), so they
  // are neither counted as stored nor owed a seat. Only on an americano body:
  // anywhere else a pair the harness never posted is an extra entrant.
  const minted = posted.stages.some((b) => b.kind === "americano") ? built.entrants.filter((r) => r.kind === "pair") : [];
  const stored = built.entrants.filter((r) => !minted.includes(r));
  items.push({ ok: stored.length === posted.entrants.length, note: `${stored.length} entrant(s) stored, ${posted.entrants.length} posted${minted.length > 0 ? ` (${minted.length} product-minted pair entrant(s) aside)` : ""}` });
  items.push({ ok: built.echo.length === posted.entrants.length, note: `add answered ${built.echo.length} entrant(s), ${posted.entrants.length} posted` });
  for (const e of posted.entrants) {
    const n = stored.filter((r) => r.seed === e.seed && r.display_name === e.displayName).length;
    items.push({ ok: n === 1, note: `posted seed ${e.seed} (${e.displayName}) stored ${n} time(s)` });
  }
  const seats = observed.stages.map(seatsEntrant);
  for (const r of stored) items.push({ ok: seats.some((seated) => seated(r.id)), note: `${r.id} (seed ${r.seed}) is seated in no fixture of the stage` });
  return assertion("life-built-as-posted", items);
}

/** R15: the product's outcome for every posted stream equals the engine's
 *  in-process fold of the fixture's whole stream. A fixture carrying events the
 *  harness never posted cannot be refolded here, so it is unjudgeable — a
 *  failing item, never a silent pass. */
export function foldParity(rec: Recorder): CheckResult {
  return assertion("life-fold-parity", rec.parity.map((p) => (p.finishedBefore !== null
    ? { ok: false, note: `${p.fixtureId}: already ${p.finishedBefore} before the harness posted — a result it never wrote, and no recorded withdrawal explains it` }
    : p.foreign !== 0
    ? {
      ok: false,
      note: p.foreign > 0
        ? `${p.fixtureId}: ${p.foreign} event(s) on the fixture the harness did not post — parity unjudgeable`
        : `${p.fixtureId}: the product holds ${-p.foreign} fewer event(s) than the harness posted — parity unjudgeable`,
    }
    : {
      // m-4: two nulls are not parity. A fold with no outcome passes only for
      // a request whose outcome is recorded, not asserted (an abandon), and a
      // fold that is not what the harness asked for fails even when the
      // product agrees with it.
      ok: (p.local !== null || p.request === "unasserted") && p.request !== "mismatch" && JSON.stringify(p.local) === JSON.stringify(p.product),
      note: `${p.fixtureId}: engine ${JSON.stringify(p.local)} vs product ${JSON.stringify(p.product)}${p.request === "mismatch" ? " — not the outcome the harness asked for" : ""}`,
    })));
}

const text = (o: ObservedOutcome | null): string => JSON.stringify(o);

/** Final review I-1: every finished fixture's STORED result is one the
 *  harness can account for. foldParity reads the POST answer; this reads the
 *  row the product kept (GET …/fixtures), so a product that answers one
 *  result and stores another cannot pass both. Per finished fixture with a
 *  seated side:
 *  - the harness posted its whole stream: the stored outcome is the local
 *    fold's (kind and winner) — unless the recorded cascade struck it since;
 *  - otherwise it is a bye, or the recorded withdrawal cascade wrote it;
 *  - anything else (a result nobody posted, a posted one stored differently,
 *    a stream the harness does not hold whole) fails. */
export function resultsAsPosted(rec: Recorder, observed: ObservedRun): CheckResult {
  const items: Item[] = [];
  const w = observed.withdrawal;
  for (const f of observed.stages.flatMap((s) => s.fixtures)) {
    if (!isTerminal(f.status) || (f.home === null && f.away === null)) continue;
    const p = rec.parity.find((x) => x.fixtureId === f.id);
    const stored = `${f.id}: stored ${f.status} ${text(f.outcome)}`;
    if (p !== undefined && p.finishedBefore === null && p.foreign === 0 && p.local !== null) {
      const same = sameOutcome(f.outcome, p.local);
      items.push(same || !cascadeWrote(f, w)
        ? { ok: same, note: `${stored}, the harness posted and folded ${text(p.local)}` }
        : { ok: true, note: `${stored}: struck by the recorded ${w!.policy} after the harness posted it` });
    } else if (p !== undefined) {
      const why = p.finishedBefore !== null ? `already ${p.finishedBefore} before it posted` : p.foreign !== 0 ? `${p.foreign} foreign event(s)` : "its local fold has no outcome";
      items.push({ ok: false, note: `${stored} over a stream the harness cannot fold (${why})` });
    } else if (isBye(f)) {
      items.push({ ok: true, note: `${stored}: a bye` });
    } else if (cascadeWrote(f, w)) {
      items.push({ ok: true, note: `${stored}: written by the recorded ${w!.policy}` });
    } else {
      items.push({ ok: false, note: `${stored} — the harness never posted it, and no bye or recorded withdrawal explains it` });
    }
  }
  return assertion("life-results-as-posted", items);
}

/** The public table equals the org one, both ways (m-4): every org row is on
 *  the public page with the same rank and points, and the public page shows no
 *  table, pool or row the org side does not. The reverse pass adds an item only
 *  for an extra — a matched row was already counted going forwards. */
export function publicStandingsMatch(observed: ObservedRun, pub: PublicStandingsOut): CheckResult {
  const items: Item[] = [];
  for (const s of observed.stages) for (const pool of s.standings) {
    const p = pub.standings.find((x) => x.stage_id === s.id && x.pool_id === pool.poolId);
    if (p === undefined) { items.push({ ok: false, note: `stage ${s.seq} pool ${pool.poolId}: missing from public standings` }); continue; }
    for (const row of pool.rows) {
      const pr = p.rows.find((r) => r.entrantId === row.entrantId);
      items.push({ ok: pr !== undefined && pr.rank === row.rank && (pr.points ?? null) === row.points, note: `${row.entrantId}: org ${row.rank}/${row.points} vs public ${pr?.rank}/${pr?.points}` });
    }
  }
  for (const p of pub.standings) {
    const s = observed.stages.find((x) => x.id === p.stage_id);
    if (s === undefined) { items.push({ ok: false, note: `stage ${p.stage_id}: public table for a stage the run never observed` }); continue; }
    const pool = s.standings.find((x) => x.poolId === p.pool_id);
    if (pool === undefined) { items.push({ ok: false, note: `stage ${s.seq} pool ${p.pool_id}: public table with no org table` }); continue; }
    for (const r of p.rows) {
      if (!pool.rows.some((o) => o.entrantId === r.entrantId)) items.push({ ok: false, note: `${r.entrantId}: public row (stage ${s.seq} pool ${p.pool_id}) with no org row` });
    }
  }
  return assertion("life-public-standings-match", items);
}

/** R9: whether a draw is reachable is the module's declaration (drawOk comes
 *  from supportsDraws), never a typed table. */
export function drawPathExercised(rec: Recorder, observed: ObservedRun, drawOk: boolean): CheckResult {
  if (!drawOk) return assertion("life-draw-path-exercised", [], "supportsDraws is false for this stage");
  const draws = observed.stages.flatMap((s) => s.fixtures).filter((f) => f.outcome?.kind === "draw");
  return assertion("life-draw-path-exercised", [{ ok: rec.drawsPosted > 0 && draws.length === rec.drawsPosted, note: `posted ${rec.drawsPosted} draws, product shows ${draws.length}` }]);
}

/** W2a (finding 16): a run that played a BRACKET stage must have exercised a decider — a chess tie-break or an
 *  organiser settle (a level result held and closed, or an abandon at a real score closed) — or it proved only the
 *  straight-win path that never stalled. The count is what the harness POSTED (Recorder), cross-checked against what
 *  the product shows: every settled fixture reads back with a `settled_*` win, every tie-break with a `tiebreak_*`
 *  win. Zero deciders in a run with a bracket stage is a FAILURE, never an abstention (R25); a run with no bracket
 *  stage abstains by name — the rule says nothing about it. */
export function bracketDeciderExercised(rec: Recorder, observed: ObservedRun): CheckResult {
  const brackets = observed.stages.filter((s) => forbidsLevelResult(s.kind as StageKind));
  if (brackets.length === 0) return assertion("life-bracket-decider-exercised", [], "no bracket stage in this run: a level result cannot stall it");
  const fixtures = brackets.flatMap((s) => s.fixtures);
  const settled = fixtures.filter((f) => f.outcome?.kind === "win" && f.outcome.method?.startsWith("settled_") === true).length;
  const tiebroken = fixtures.filter((f) => f.outcome?.kind === "win" && f.outcome.method?.startsWith("tiebreak_") === true).length;
  return assertion("life-bracket-decider-exercised", [
    { ok: rec.settlesPosted + rec.tiebreaksPosted > 0, note: `${brackets.length} bracket stage(s) and no decider posted (0 settles, 0 tie-breaks)` },
    { ok: settled === rec.settlesPosted, note: `posted ${rec.settlesPosted} settle(s), the product shows ${settled} settled win(s)` },
    { ok: tiebroken === rec.tiebreaksPosted, note: `posted ${rec.tiebreaksPosted} tie-break(s), the product shows ${tiebroken} tie-break win(s)` },
  ]);
}

/** W2a (ruling T15-R3): every bracket match the harness drove is judged against the reference family `bracket-finish`
 *  (reference-bracket.ts): the oracle is given the actions driven, and its status, advancing winner and method must be
 *  the product's. One item per judged drive. A drive the oracle does not cover (a walkover, or the oracle's own
 *  OutOfScope / RuledOut) is NOT judged: counted and named in the verdict's reason, never silent. A run with a bracket
 *  stage that judged nothing fails (R25); a run with no bracket stage abstains by name. */
export function referenceBracketFinish(rec: Recorder, observed: ObservedRun): CheckResult {
  const brackets = observed.stages.filter((s) => forbidsLevelResult(s.kind as StageKind));
  if (brackets.length === 0) return assertion("life-reference-bracket-finish", [], "no bracket stage in this run: the bracket-finish oracle says nothing about it");
  const judgements = rec.bracketDrives.map(judgeDrive);
  const items: Item[] = judgements.flatMap((j) => (j.judged ? [{ ok: j.ok, note: j.note }] : []));
  const skipped = judgements.flatMap((j) => (j.judged ? [] : [j.why]));
  // A judged drive whose loser line could not be read is judged on everything else: counted and named too.
  const loserSkipped = judgements.flatMap((j) => (j.judged && j.loserNotJudged !== null ? [j.loserNotJudged] : []));
  const verdict = assertion("life-reference-bracket-finish", items);
  if (verdict.verdict !== "pass" || (skipped.length === 0 && loserSkipped.length === 0)) return verdict;
  const parts = [
    ...(skipped.length === 0 ? [] : [`${skipped.length} drive(s) not judged (${[...new Set(skipped)].join("; ")})`]),
    ...(loserSkipped.length === 0 ? [] : [`loser seat not judged on ${loserSkipped.length} drive(s) (${[...new Set(loserSkipped)].join("; ")})`]),
  ];
  return { ...verdict, reason: `${verdict.reason}; ${parts.join("; ")}` };
}

/** The format lock's answer: usecases/divisions.ts `formatLocked()` throws
 *  `new HttpError(409, …, "FORMAT_LOCKED")` (pinned against that text by
 *  scenarios.test.ts). */
export const FORMAT_LOCK = Object.freeze({ status: 409, code: "FORMAT_LOCKED" });

/** R28: a locked format is refused BY THE LOCK, never a silent accept or a
 *  500. Final review m-3: any named 4xx is not enough — a new domain refusal
 *  on the same PATCH (ENTRANT_KIND_IN_USE, say) would pass with the lock
 *  gone — so the answer must be the lock's own status and code. */
export function formatEditRefusedNamed(edit: ConfigEditObs): CheckResult {
  const fmt = edit.attempts.filter((a) => a.kind === "format");
  if (fmt.length === 0) return assertion("life-format-edit-refused-named", [], "no format field to edit for this sport");
  return assertion("life-format-edit-refused-named", fmt.map((a) => ({
    ok: isNamedRefusal(a.status, a.code) && a.status === FORMAT_LOCK.status && a.code === FORMAT_LOCK.code,
    note: `format edit → ${a.status} ${a.code ?? "(no code)"}, expected ${FORMAT_LOCK.status} ${FORMAT_LOCK.code}`,
  })));
}

/** Controller ruling (fix round 1, I-2): the entrants-only save is the one
 *  edit the format lock lets through (divisions.ts:795-870), so it must be
 *  ACCEPTED — a 2xx. A 409 here is a red finding, never an expected refusal.
 *  configProbe always makes one, so none attempted is the vacuous fail. */
export function entrantsEditAccepted(edit: ConfigEditObs): CheckResult {
  return assertion("life-entrants-edit-accepted", edit.attempts.filter((a) => a.kind === "entrants_only")
    .map((a) => ({ ok: a.status >= 200 && a.status < 300, note: `entrants-only save → ${a.status} ${a.code ?? "(no code)"}` })));
}

/** Controller ruling (fix round 1b): a stage whose fixtures are ALL finished
 *  must complete. A refused /complete, named or not, or an answer of
 *  `completed: false` is then a product failure to finish. I4 stays as it is,
 *  since it judges only whether a refusal is NAMED. A stage with an open
 *  fixture is not counted, because life-loop-bounded owns that case. So is a
 *  stage with no fixtures: the empty set would pass "all finished". */
export function stageCompleted(observed: ObservedRun): CheckResult {
  const finished = observed.stages.filter((s) => s.fixtures.length > 0 && s.fixtures.every((f) => isTerminal(f.status)));
  return assertion("life-stage-completed", finished.map((s) => ({
    ok: s.complete?.completed === true,
    note: `stage ${s.seq}: all ${s.fixtures.length} fixtures finished, complete → ${s.complete === null ? "never asked" : `${s.complete.status} ${s.complete.code ?? "(no code)"} completed=${s.complete.completed}`}`,
  })), finished.length === 0 ? "no stage has every fixture finished (life-loop-bounded judges an unfinished one)" : null);
}

/** PF5 + I-1: red in EVERY scenario unless the play loop ran to its end —
 *  exit "drained" — AND left no fixture of the stage open. A cap, a refused
 *  generate (named or not) or an empty pair round each stop the loop early;
 *  a generate that stops listing open fixtures, or a TBD seat nobody fills,
 *  "drains" with work unplayed. The cap also makes I1/I2/I4 abstain
 *  (cut_short), and I4 accepts named refusals, so without this check any of
 *  them could read ✅ over an unfinished stage. */
export function loopBounded(rec: Recorder, observed: ObservedRun): CheckResult {
  const open = observed.stages.flatMap((s) => s.fixtures).filter((f) => !isTerminal(f.status));
  return assertion("life-loop-bounded", [
    { ok: rec.exit === "drained", note: `play loop exited ${rec.exit ?? "never"}` },
    { ok: open.length === 0, note: `${open.length} fixture(s) left unfinished: ${open.slice(0, 8).map((f) => `${f.id} ${f.status}`).join(", ")}` },
  ]);
}

/** W1-driving T6 (T45-R1): every team fixture the harness scored had a
 *  lineup PUT for each of its division-entrant sides before anything was
 *  posted — the engine reads per-fixture lineups only (engine-db
 *  loadLineupPair), so a side without one plays on the module default. One
 *  item per scored side, counted. A non-team or rosterless division owes no
 *  lineup (an abstain with its reason); a team division that scored nothing
 *  is the vacuous fail. */
export function lineupsPut(rec: Recorder, setup: Pick<DivisionSetup, "kind" | "rosterless"> & { readonly stages?: readonly Pick<StageRef, "kind">[] }): CheckResult {
  if (setup.kind !== "team") return assertion("life-lineups-put", [], `${setup.kind} entrants carry no lineup`);
  if (setup.rosterless) return assertion("life-lineups-put", [], "rosterless team entrants (PADPROOF, D3) carry no lineup");
  // W1-driving Task 8: an americano stage seats only the pair entrants it
  // mints (stages.ts pairEntrantsFor), which carry no roster and take no
  // lineup (ensureLineups skips them by name) — no item could exist.
  if (setup.stages !== undefined && setup.stages.length > 0 && setup.stages.every((s) => s.kind === "americano")) {
    return assertion("life-lineups-put", [], "an americano stage seats product-minted pair entrants, which carry no lineup");
  }
  // The items are the shared planner's (lineup-plan.ts lineupItems, T14-R3): the model's lineup check counts the same ones.
  const items: Item[] = lineupItems(rec.teamPosts, rec.lineupSides);
  return assertion("life-lineups-put", items);
}
