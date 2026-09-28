// Design §7.3 invariants as PURE functions with their preconditions as DATA.
// Each returns {verdict, checked, evidence}; evaluateInvariant applies the
// preconditions and the anti-vacuity guard (R25: zero checked is a failure),
// so every spec — including W1b's and W10's additions — inherits both.
//
// Imports: types, plus observed.ts's pure helpers — the one value import the
// boundary test allows (PF7), so the terminal-status list and the outcome
// helpers have one authority instead of a copy here.
import type { CheckResult } from "./results.ts";
import type { CaseFact, InvariantResult, ObservedFixture, ObservedRun, ObservedStage } from "./observed.ts";
import { isTerminal, sameOutcome, sameResult, twoSided, winnerOf } from "./observed.ts";

export interface InvariantSpec {
  readonly id: string;
  readonly description: string;
  readonly stageKinds: readonly string[] | "any";
  readonly abstainOn: readonly CaseFact[];
  readonly abstainOnStageConfig: readonly string[];
  readonly requiresCompletedStage: boolean;
  check(stages: readonly ObservedStage[], run: ObservedRun): InvariantResult;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);
const result = (fails: string[], checked: number, notes: string[] = []): InvariantResult =>
  ({ verdict: fails.length > 0 ? "fail" : "pass", checked, evidence: [...fails, ...notes].slice(0, 12) });
const ABSTAIN = (why: string): InvariantResult => ({ verdict: "abstain", checked: 0, evidence: [`abstain: ${why}`] });

const I1: InvariantSpec = {
  id: "I1-rr-pair-once-per-leg",
  description: "every round-robin pair meets exactly once per leg",
  stageKinds: ["league", "group"],
  abstainOn: ["withdrawn", "expunged", "voided", "cut_short", "late_entry"],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const legs = typeof s.config.legs === "number" ? s.config.legs : 1;
      const pools = new Map<string, Set<string>>();
      const met = new Map<string, number>();
      for (const f of s.fixtures.filter(twoSided)) {
        if (f.home === f.away) fails.push(`${f.id}: self-play ${f.home}`);
        const pool = pools.get(f.poolId ?? "") ?? new Set<string>();
        pool.add(f.home!).add(f.away!);
        pools.set(f.poolId ?? "", pool);
        met.set(pairKey(f.home!, f.away!), (met.get(pairKey(f.home!, f.away!)) ?? 0) + 1);
      }
      // A league has one pool: its members are the whole field, so an entrant
      // with NO fixture is still counted (it would otherwise escape).
      if (s.kind === "league") pools.set("", new Set(s.field));
      const pooled = new Set([...pools.values()].flatMap((p) => [...p]));
      for (const e of s.field) if (!pooled.has(e)) fails.push(`${e} in no pool`);
      for (const members of pools.values()) {
        const m = [...members].sort();
        for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
          checked++;
          const k = pairKey(m[i]!, m[j]!);
          const times = met.get(k) ?? 0;
          if (times !== legs) fails.push(`${k} met ${times}, expected ${legs}`);
        }
      }
    }
    return result(fails, checked);
  },
};

const I2: InvariantSpec = {
  id: "I2-bracket-one-champion-ranks-permutation",
  description: "a completed bracket ranks every entrant once and its rank 1 is the one unbeaten entrant",
  stageKinds: ["knockout", "double_elim", "stepladder", "page_playoff"],
  abstainOn: ["shared_place_declared", "cut_short"],
  abstainOnStageConfig: [],
  requiresCompletedStage: true,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const ranks = s.complete?.finalRanks ?? [];
      const counts = new Map<string, number>();
      for (const id of ranks) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const e of s.field) {
        checked++;
        const c = counts.get(e) ?? 0;
        if (c !== 1) fails.push(`${e} ${c === 0 ? "not ranked" : `ranked ${c}×`}`);
      }
      for (const id of counts.keys()) if (!s.field.includes(id)) fails.push(`${id} ranked but not in the field`);
      if (s.kind === "knockout" && s.field.length > 0) {
        checked++;
        const lost = new Set<string>();
        for (const f of s.fixtures.filter(twoSided)) {
          const w = winnerOf(f.outcome);
          if (w === null) { if (isTerminal(f.status) && f.outcome !== null) fails.push(`${f.id}: bracket fixture ended ${f.outcome.kind}`); continue; }
          lost.add(w === f.home ? f.away! : f.home!);
        }
        const unbeaten = s.field.filter((e) => !lost.has(e));
        if (unbeaten.length !== 1) fails.push(`${unbeaten.length} unbeaten entrants: ${unbeaten.join(",")}`);
        else if (ranks[0] !== unbeaten[0]) fails.push(`rank 1 is ${ranks[0] ?? "nobody"}, unbeaten is ${unbeaten[0]}`);
      }
    }
    return result(fails, checked);
  },
};

const I3: InvariantSpec = {
  id: "I3-table-points-equal-declared",
  description: "each table row's points equal Σ the sport's declared points over its results",
  stageKinds: ["league", "group", "swiss"],
  abstainOn: [],
  abstainOnStageConfig: ["points", "carry_deltas", "rank_overrides"],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    let skipped = 0;
    for (const s of stages) {
      const rows = new Map(s.standings.flatMap((p) => p.rows).map((r) => [r.entrantId, r]));
      const byEntrant = new Map<string, ObservedFixture[]>();
      for (const f of s.fixtures.filter((x) => twoSided(x) && isTerminal(x.status))) {
        for (const e of [f.home!, f.away!]) byEntrant.set(e, [...(byEntrant.get(e) ?? []), f]);
      }
      for (const [e, fx] of byEntrant) if (!rows.has(e) && fx.some((f) => f.outcome !== null)) fails.push(`${e} has results but no row`);
      for (const [e, row] of rows) {
        // A fixture with NO outcome (voided/expunged) contributes 0. One WITH an
        // outcome counts only if the harness declared exactly that result; a
        // result the server wrote on its own (cascade walkover, bye) makes the
        // entrant unjudgeable here → skipped and counted.
        const fx = (byEntrant.get(e) ?? []).filter((f) => f.outcome !== null);
        if (fx.some((f) => f.declared === null || !sameOutcome(f.outcome, f.declared.forOutcome))) { skipped++; continue; }
        checked++;
        const expected = fx.reduce((sum, f) => sum + (f.home === e ? f.declared!.home : f.declared!.away), 0);
        if (row.points === null) fails.push(`${e}: row has no points`);
        else if (Math.abs(row.points - expected) > 1e-9) fails.push(`${e}: table ${row.points}, declared Σ ${expected}`);
      }
    }
    return result(fails, checked, skipped > 0 ? [`skipped ${skipped} entrant(s) with undeclared or changed results`] : []);
  },
};

const I4: InvariantSpec = {
  id: "I4-nothing-ends-stuck",
  description: "every generate/pair returns fixtures or a named refusal; every stage completes or refuses with a named reason",
  stageKinds: "any",
  abstainOn: ["cut_short"],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      for (const g of s.generates) {
        checked++;
        const ok2xx = g.status >= 200 && g.status < 300;
        if (ok2xx && g.total === 0) fails.push(`stage ${s.seq}: empty generate (R13)`);
        if (!ok2xx && g.code === null) fails.push(`stage ${s.seq}: generate refused ${g.status} with no code`);
      }
      for (const p of s.pairRounds) {
        checked++;
        if (p.seated === 0) fails.push(`stage ${s.seq}: round ${p.roundNo} paired nobody (SW-H1)`);
      }
      if (s.complete === null) { fails.push(`stage ${s.seq}: never asked to complete`); continue; }
      checked++;
      const refusedNamed = s.complete.status >= 400 && s.complete.code !== null;
      if (!s.complete.completed && !refusedNamed) fails.push(`stage ${s.seq}: did not complete and named no reason`);
      if (s.complete.completed) {
        for (const f of s.fixtures.filter(twoSided)) {
          checked++;
          if (!isTerminal(f.status)) fails.push(`${f.id}: ${f.status} inside a completed stage`);
        }
      }
    }
    return result(fails, checked);
  },
};

const I5: InvariantSpec = {
  id: "I5-config-edit-never-rescores",
  description: "a config edit (accepted or refused) never changes a finished fixture's result",
  stageKinds: "any",
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(_stages, run) {
    const edit = run.configEdit;
    if (edit === null || edit.attempts.length === 0) return ABSTAIN("no config edit attempted");
    const fails: string[] = [];
    for (const b of edit.before) {
      const a = edit.after.find((x) => x.id === b.id);
      if (a === undefined) fails.push(`${b.id}: vanished after the edit`);
      else if (!sameResult(a, b)) {
        fails.push(`${b.id}: ${b.status}/${winnerOf(b.outcome) ?? b.outcome?.kind} → ${a.status}/${winnerOf(a.outcome) ?? a.outcome?.kind}`);
      }
    }
    return result(fails, edit.before.length, edit.attempts.map((x) => `${x.kind}: ${x.status} ${x.code ?? ""}`.trim()));
  },
};

const I6: InvariantSpec = {
  id: "I6-swiss-no-rematch",
  description: "no two entrants meet twice in a swiss stage",
  stageKinds: ["swiss"],
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const seen = new Map<string, number>();
      for (const f of s.fixtures.filter(twoSided)) {
        checked++;
        const k = pairKey(f.home!, f.away!);
        if (seen.has(k)) fails.push(`${k} rematched in rounds ${seen.get(k)} and ${f.roundNo}`);
        else seen.set(k, f.roundNo ?? 0);
      }
    }
    return result(fails, checked);
  },
};

export const INVARIANTS: readonly InvariantSpec[] = Object.freeze([I1, I2, I3, I4, I5, I6]);

export function evaluateInvariant(spec: InvariantSpec, run: ObservedRun): InvariantResult {
  const blocking = spec.abstainOn.filter((f) => run.facts.includes(f));
  if (blocking.length > 0) return ABSTAIN(`case fact ${blocking.join(", ")}`);
  let stages = spec.stageKinds === "any" ? run.stages : run.stages.filter((s) => (spec.stageKinds as readonly string[]).includes(s.kind));
  stages = stages.filter((s) => !spec.abstainOnStageConfig.some((k) => k in s.config));
  if (spec.requiresCompletedStage) stages = stages.filter((s) => s.complete?.completed === true);
  if (stages.length === 0) return ABSTAIN(`no applicable stage (${spec.stageKinds === "any" ? "any" : spec.stageKinds.join("/")})`);
  const r = spec.check(stages, run);
  // R25 — the guard every spec inherits.
  if (r.verdict === "pass" && r.checked === 0) return { verdict: "fail", checked: 0, evidence: ["checked 0 items (vacuous, R25)", ...r.evidence] };
  return r;
}

export function evaluateInvariants(run: ObservedRun): CheckResult[] {
  return INVARIANTS.map((spec) => {
    const r = evaluateInvariant(spec, run);
    return { id: spec.id, kind: "invariant", verdict: r.verdict, checked: r.checked, reason: r.verdict === "pass" ? spec.description : (r.evidence[0] ?? ""), evidence: r.evidence };
  });
}
