// Scenario assertions. Every one goes through `assertion`, so R25 holds for
// them exactly as it does for the invariants: zero items checked is a FAIL,
// and only a stated reason may abstain.
import type { PublicStandingsOut } from "../driver/types.ts";
import { cascadeWrote, isBye, isNamedRefusal, isTerminal, sameOutcome, type ConfigEditObs, type ObservedOutcome, type ObservedRun } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import type { BuiltReadback, Recorder } from "./common.ts";

export interface Item { ok: boolean; note: string }

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
    { ok: built.stages.length === posted.stages.length, note: `${built.stages.length} stage(s) built, ${posted.stages.length} posted` },
  ];
  for (const body of posted.stages) {
    const s = built.stages.find((x) => x.seq === body.seq);
    items.push({ ok: s?.kind === body.kind, note: `stage ${body.seq}: built ${s?.kind ?? "nothing"}, posted ${body.kind}` });
    for (const [k, v] of Object.entries(body.config)) {
      const got = s === undefined ? undefined : s.config[k];
      items.push({ ok: s !== undefined && canonical(got) === canonical(v), note: `stage ${body.seq} config.${k}: built ${canonical(got)}, posted ${canonical(v)}` });
    }
  }
  items.push({ ok: built.entrants.length === posted.entrants.length, note: `${built.entrants.length} entrant(s) stored, ${posted.entrants.length} posted` });
  items.push({ ok: built.echo.length === posted.entrants.length, note: `add answered ${built.echo.length} entrant(s), ${posted.entrants.length} posted` });
  for (const e of posted.entrants) {
    const n = built.entrants.filter((r) => r.seed === e.seed && r.display_name === e.displayName).length;
    items.push({ ok: n === 1, note: `posted seed ${e.seed} (${e.displayName}) stored ${n} time(s)` });
  }
  const seated = new Set(observed.stages.flatMap((s) => s.fixtures.flatMap((f) => [f.home, f.away])));
  for (const r of built.entrants) items.push({ ok: seated.has(r.id), note: `${r.id} (seed ${r.seed}) is seated in no fixture of the stage` });
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

/** R28: a locked format is a NAMED refusal, never a silent accept or a 500.
 *  Every api-v1 error carries some code, so "has a code" proves nothing — the
 *  code must be a domain one (observed.ts isNamedRefusal). */
export function formatEditRefusedNamed(edit: ConfigEditObs): CheckResult {
  const fmt = edit.attempts.filter((a) => a.kind === "format");
  if (fmt.length === 0) return assertion("life-format-edit-refused-named", [], "no format field to edit for this sport");
  return assertion("life-format-edit-refused-named", fmt.map((a) => ({ ok: isNamedRefusal(a.status, a.code), note: `format edit → ${a.status} ${a.code ?? "(no code)"}` })));
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
