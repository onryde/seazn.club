// Scenario assertions. Every one goes through `assertion`, so R25 holds for
// them exactly as it does for the invariants: zero items checked is a FAIL,
// and only a stated reason may abstain.
import type { PublicStandingsOut } from "../driver/types.ts";
import { isNamedRefusal, isTerminal, type ConfigEditObs, type ObservedRun } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import type { Recorder } from "./common.ts";

export interface Item { ok: boolean; note: string }

export function assertion(id: string, items: readonly Item[], abstainReason: string | null = null): CheckResult {
  if (abstainReason !== null) return { id, kind: "assertion", verdict: "abstain", checked: 0, reason: abstainReason, evidence: [] };
  if (items.length === 0) return { id, kind: "assertion", verdict: "fail", checked: 0, reason: "checked 0 items (vacuous, R25)", evidence: [] };
  const bad = items.filter((i) => !i.ok).map((i) => i.note);
  return { id, kind: "assertion", verdict: bad.length > 0 ? "fail" : "pass", checked: items.length, reason: bad[0] ?? `${items.length} ok`, evidence: bad.slice(0, 12) };
}

/** R15: the product's outcome for every posted stream equals the engine's
 *  in-process fold of the fixture's whole stream. A fixture carrying events the
 *  harness never posted cannot be refolded here, so it is unjudgeable — a
 *  failing item, never a silent pass. */
export function foldParity(rec: Recorder): CheckResult {
  return assertion("life-fold-parity", rec.parity.map((p) => (p.foreign !== 0
    ? {
      ok: false,
      note: p.foreign > 0
        ? `${p.fixtureId}: ${p.foreign} event(s) on the fixture the harness did not post — parity unjudgeable`
        : `${p.fixtureId}: the product holds ${-p.foreign} fewer event(s) than the harness posted — parity unjudgeable`,
    }
    : { ok: JSON.stringify(p.local) === JSON.stringify(p.product), note: `${p.fixtureId}: engine ${JSON.stringify(p.local)} vs product ${JSON.stringify(p.product)}` })));
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
