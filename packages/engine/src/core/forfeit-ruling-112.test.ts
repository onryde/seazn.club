// W2b ruling 112 (2026-10-11, owner "fix it"; amends Appendix A X-RS-1) — a walkover stays recordable after Start until
// something is played. The only real walkover on production and the active one on staging are both stored as
// `core.start` (seq 1) → `core.forfeit{by: <entrant id>, reason: "walkover"}` (seq 2): the organiser pressed Start and
// the opponent never showed. The rule, as the ruling words it:
//   - for a walkover (and a double walkover) the phase reads "pre" while no sport (module-owned) event is active after
//     `core.start`; kernel admin events do not count as play;
//   - once anything is played a walkover is refused as before, and chess keeps its wider `walkoverPhases`.
// Every expectation below is that text (or the module's own declarations: its generator's play, its `walkoverPhases`,
// its `forfeitPhase`), never read back from the guard. Each sweep counts what it checked; zero checked is a failure.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { CORE_EVENT_SCHEMAS, foldMatchWithStoppage, forfeitAdmission, outcomeOf, playRecorded, type EventEnvelope } from "./events.ts";
import { mulberry32 } from "./rng.ts";
import { FORFEIT_REASONS, type ForfeitPhase, type LineupPair } from "./types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const firstCfg = (m: AnySportModule): unknown => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
/** The module's own play needs a cfg it can be undecided under: the first variant, else the bracket deciders over it
 *  (chess: its one sport event decides a plain game; under the deciders a draw is held for its tie-break). */
const cfgsOf = (m: AnySportModule): unknown[] => {
  const base = firstCfg(m);
  return [base, m.configSchema.parse({ ...(base as object), ...m.bracketDeciders(base) })];
};
/** The phases a walkover is recordable in, as the module declares them (absent ⇒ ["pre"], plan D3 R2). */
const walkoverPhasesOf = (m: AnySportModule): readonly ForfeitPhase[] => m.walkoverPhases ?? ["pre"];
const START = () => ev(1, "core.start");
const fold = (m: AnySportModule, cfg: unknown, l: LineupPair, events: EventEnvelope[]) => foldMatchWithStoppage(m as never, cfg as never, l, events);

/** A sport's scene: a cfg, and the start followed by one REAL sport event of its own (its generator's). */
function playedScene(m: AnySportModule): { cfg: unknown; l: LineupPair; played: EventEnvelope } {
  const l = defaultLineupPair(m.positions);
  for (const cfg of cfgsOf(m)) {
    const played = onePlayEvent(m, cfg, l, [START()]);
    if (played !== null) return { cfg, l, played };
  }
  throw new Error(`${m.key}: its generator draws no undecided sport event after the start under either cfg`);
}

/** The kernel types ruling 112 says are not play — every type CORE_EVENT_SCHEMAS registers, typed here from the
 *  ruling's own list (the start itself, suspend/resume, the lineups, and every other kernel or annotation type), so a
 *  core type added later must be ruled on before this passes. */
const NOT_PLAY: readonly string[] = [
  "core.start", "core.void", "core.forfeit", "core.abandon", "core.finalize", "core.note", "core.award", "core.suspend", "core.resume", "core.settle",
  "core.lineup.substitution", "core.lineup.replacement", "core.lineup.position", "core.lineup.retirement", "core.lineup.entry",
];

describe("ruling 112: what counts as play (X-RS-1 as amended)", () => {
  it("empty case first: no ledger, a bare start, and a start voided are not play", () => {
    // A module declaring nothing (ruling 118's `startIsPlay` is chess's alone, forfeit-ruling-118.test.ts).
    expect(playRecorded([], {})).toBe(false);
    expect(playRecorded([START()], {})).toBe(false);
    expect(playRecorded([START(), ev(2, "core.void", {}, "e-1")], {})).toBe(false);
    // Ruling 118's declaration: the Start is play, until it is voided.
    expect(playRecorded([], { startIsPlay: true })).toBe(false);
    expect(playRecorded([START()], { startIsPlay: true })).toBe(true);
    expect(playRecorded([START(), ev(2, "core.void", {}, "e-1")], { startIsPlay: true })).toBe(false);
  });

  it("X-RS-1 (ruling 112): every kernel type is admin, never play — and every sport's own event after the start is", () => {
    expect([...NOT_PLAY].sort(), "a core type was added: rule on whether it is play").toEqual(Object.keys(CORE_EVENT_SCHEMAS).sort());
    let kernel = 0;
    for (const type of NOT_PLAY) {
      expect(playRecorded([START(), { id: "e-2", type }], {}), type).toBe(false);
      kernel++;
    }
    expect(kernel, `kernel types checked: ${kernel}`).toBe(15);
    let sports = 0;
    forEachSport(({ module: m }) => {
      const { played } = playedScene(m);
      expect(played.type.startsWith(`${m.key}.`), `${m.key}: its play is in its own namespace (${played.type})`).toBe(true);
      expect(playRecorded([START(), played], m), `${m.key} ${played.type}`).toBe(true);
      // The sequence: voiding the one sport event takes it back to nothing played — except where the Start itself is
      // play (ruling 118, chess), which stands.
      expect(playRecorded([START(), played, ev(3, "core.void", {}, played.id)], m), `${m.key} voided`).toBe(m.startIsPlay === true);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  });

  it("X-RS-1 (ruling 112): a sport event BEFORE the start is not play — the ruling counts what follows Start", () => {
    // The module's own pre-start events (a pre-kick-off card, a hockey suspension, a generic score — whatever its
    // generator draws that the fold accepts before any core.start), then Start, then the walkover.
    let checked = 0;
    const withPreStart: string[] = [];
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const started = fold(m, cfg, l, [START()]).state;
      const seen = new Set<string>();
      for (let seed = 1; seed <= 64; seed++) {
        const drawn = m.arbitraryEvent?.(started, mulberry32(seed)) ?? null;
        if (drawn === null || drawn.type.startsWith("core.") || seen.has(drawn.type)) continue;
        seen.add(drawn.type);
        const pre = ev(1, drawn.type, drawn.payload);
        let alone;
        try { alone = foldMatchWithStoppage(m as never, cfg as never, l, [pre], { strictFromSeq: 1 }); } catch { continue; } // refused before the start
        if (outcomeOf(m as never, alone as never) !== null) continue; // it decided the match (a generic result): no walkover follows
        const stream = [pre, ev(2, "core.start"), ev(3, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })];
        // Nothing before the Start counts; the Start itself is play only where the module declares it (ruling 118).
        expect(playRecorded(stream.slice(0, 2), m), `${m.key} ${drawn.type} before the start`).toBe(m.startIsPlay === true);
        expect(outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, stream, { strictFromSeq: 3 }) as never), `${m.key} ${drawn.type}`).toEqual({
          kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "walkover",
        });
        if (!withPreStart.includes(m.key)) withPreStart.push(m.key);
        checked++;
      }
    });
    expect(checked, `pre-start sport events checked: ${checked} (${withPreStart.join(", ")})`).toBeGreaterThan(0);
  });
});

describe("ruling 112: the stored shapes, every sport (X-RS-1 as amended)", () => {
  it("X-RS-1 (ruling 112): start → walkover is an award to the side that turned up, the side at fault its loser — both sides, write and replay", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      for (const [by, winner] of [[l.away.entrantId, l.home.entrantId], [l.home.entrantId, l.away.entrantId]] as const) {
        const stream = [START(), ev(2, "core.forfeit", { by, reason: "walkover" })];
        for (const strictFromSeq of [2, undefined]) {
          const f = foldMatchWithStoppage(m as never, cfg as never, l, stream, strictFromSeq === undefined ? undefined : { strictFromSeq });
          expect(outcomeOf(m as never, f as never), `${m.key} by ${by} ${strictFromSeq === undefined ? "replay" : "write"}`).toEqual({ kind: "award", winner, loser: by, reason: "walkover" });
          checked++;
        }
      }
    });
    expect(checked).toBe(builtinModules.length * 4);
  });

  it("X-RS-1 (ruling 112): start → double walkover folds to double_walkover in every sport — a bare start is no tie-break (R3)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const phase = m.forfeitPhase(fold(m, cfg, l, [START()]).state);
      expect(phase, `${m.key}: the module reads a bare start as play`).toBe("play");
      const f = fold(m, cfg, l, [START(), ev(2, "core.forfeit", { by: "both", reason: "walkover" })]);
      expect(outcomeOf(m as never, f as never), m.key).toEqual({ kind: "double_walkover" });
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });

  it("X-RS-1 (ruling 112): once the sport's own event is played a walkover is refused FORFEIT_REASON_WRONG_PHASE — unless the module declares a walkover in that phase (chess)", () => {
    let refused = 0;
    let admitted = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const phase = m.forfeitPhase(fold(m, cfg, l, [START(), played]).state);
      expect(phase, `${m.key}: one played event leaves the match live`).not.toBe("over");
      const walkoverAllowed = walkoverPhasesOf(m).includes(phase);
      for (const by of [l.away.entrantId, "both"]) {
        // R3 (W2b-R14): never both sides in a tie-break — the classical game was played.
        const allowed = walkoverAllowed && !(by === "both" && phase === "tiebreak");
        const code = codeOf(() => fold(m, cfg, l, [START(), played, ev(3, "core.forfeit", { by, reason: "walkover" })]));
        expect(code, `${m.key} ${played.type} then a walkover by ${by} (phase ${phase})`).toBe(allowed ? null : "FORFEIT_REASON_WRONG_PHASE");
        if (allowed) admitted++;
        else refused++;
      }
    });
    // Ten sports declare the default walkover phases, so each refuses both a one-side and a double walkover.
    expect(refused, `refused ${refused}, admitted ${admitted}`).toBeGreaterThanOrEqual(2 * (builtinModules.length - 1));
    expect(admitted + refused).toBe(2 * builtinModules.length);
  });

  it("X-RS-1 (ruling 112): a played event that is VOIDED does not count — start, play, void it, then the walkover is admitted", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const back = [START(), played, ev(3, "core.void", {}, played.id)];
      const one = fold(m, cfg, l, [...back, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]);
      expect(outcomeOf(m as never, one as never), `${m.key} one side`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "walkover" });
      const both = fold(m, cfg, l, [...back, ev(4, "core.forfeit", { by: "both", reason: "walkover" })]);
      expect(outcomeOf(m as never, both as never), `${m.key} both`).toEqual({ kind: "double_walkover" });
      checked += 2;
    });
    expect(checked).toBe(2 * builtinModules.length);
  });

  it("X-RS-1 (ruling 112): kernel admin events between the start and the walkover are not play — a note, an award, a suspension, a suspension resumed", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const person = l.home.slots[0]?.personId ?? "H-p1";
      const between: Record<string, EventEnvelope[]> = {
        note: [ev(2, "core.note", { text: "opponent not here" })],
        award: [ev(2, "core.award", { person, key: "motm" })],
        suspend: [ev(2, "core.suspend", { reason: "waiting" })],
        "suspend, resume": [ev(2, "core.suspend", {}), ev(3, "core.resume", {})],
      };
      for (const [name, mid] of Object.entries(between)) {
        const stream = [START(), ...mid, ev(mid.length + 2, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })];
        expect(outcomeOf(m as never, fold(m, cfg, l, stream) as never), `${m.key} after a ${name}`).toEqual({
          kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "walkover",
        });
        checked++;
      }
    });
    expect(checked).toBe(4 * builtinModules.length);
  });

  it("X-RS-1 (ruling 112, amended by 113 and 118): a disqualification stays recordable from the start; a retirement after a bare start is refused until something is played — except where the Start is play (chess)", () => {
    // Ruling 112 kept both from the Start; ruling 113 (2026-10-11) withdraws the retirement: nobody retires from a match
    // never played. Ruling 118 (2026-10-12): in chess the Start is play, so it keeps the retirement from the Start.
    // core/forfeit-ruling-113.test.ts and sport/forfeit-ruling-118.test.ts sweep every declared cfg; this is the 112 row.
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const dq = fold(m, cfg, l, [START(), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "disqualified" })]);
      expect(outcomeOf(m as never, dq as never), `${m.key} disqualified`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "disqualified" });
      expect(codeOf(() => fold(m, cfg, l, [START(), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "retired" })])), `${m.key} retired`).toBe(
        m.startIsPlay === true ? null : "FORFEIT_REASON_WRONG_PHASE",
      );
      checked += 2;
    });
    expect(checked).toBe(2 * builtinModules.length);
  });

  it("X-RS-1 (ruling 112): only a core.void voids — a `voids` field on any other event cancels nothing, as resolveVoids reads it", () => {
    // MD-1. `playRecorded` is the fold's reading of the ACTIVE ledger, and the active ledger is resolveVoids': a target
    // is cancelled by a `core.void` naming it, never by another event carrying the field. So the sport's play below,
    // carrying `voids: <the start>`, is still play after a start that still stands.
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const plain = ev(2, played.type, played.payload);
      const carrying = ev(2, played.type, played.payload, "e-1");
      expect(playRecorded([START(), carrying], m), `${m.key}: play carrying voids`).toBe(true);
      const walkover = ev(3, "core.forfeit", { by: l.away.entrantId, reason: "walkover" });
      expect(codeOf(() => fold(m, cfg, l, [START(), carrying, walkover])), `${m.key}: the walkover after it`).toBe(codeOf(() => fold(m, cfg, l, [START(), plain, walkover])));
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });

  it("X-RS-1 (ruling 112) + guarantee 4: the guard reads the ledger BEFORE the forfeit — play recorded after a walkover is refused ALREADY_DECIDED at that event, never the walkover retroactively", () => {
    // MD-1. A walkover after a bare start is admitted (nothing played yet); an append after it is guarantee 4's refusal,
    // naming the event appended — the stored walkover stays what it was.
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const stream = [START(), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "walkover" }), ev(3, played.type, played.payload)];
      let refusal: unknown;
      try {
        fold(m, cfg, l, stream);
      } catch (e) {
        refusal = e;
      }
      expect(refusal, `${m.key}: ${played.type} after the walkover`).toMatchObject({ code: "ALREADY_DECIDED", data: { eventId: "e-3" } });
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });
});

describe("ruling 112: the console's answer agrees with the guard (forfeitAdmission parity)", () => {
  it("X-RS-1 (ruling 112): before play, after a bare start, after play, after play voided — forfeitAdmission offers each reason exactly when the fold records it", () => {
    let judged = 0;
    let admitted = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const scenes: Record<string, EventEnvelope[]> = {
        "before play": [],
        "a bare start": [START()],
        "a start and a note": [START(), ev(2, "core.note", { text: "x" })],
        "after play": [START(), played],
        "after play voided": [START(), played, ev(3, "core.void", {}, played.id)],
      };
      for (const [name, ledger] of Object.entries(scenes)) {
        const a = forfeitAdmission(m as never, fold(m, cfg, l, ledger).state, { playRecorded: playRecorded(ledger, m) });
        for (const by of [l.away.entrantId, "both"]) {
          for (const reason of FORFEIT_REASONS) {
            if (by === "both" && reason !== "walkover") continue; // the schema: "both" is only a walkover
            const says = by === "both" ? a.both : a.reasons.includes(reason);
            const code = codeOf(() => fold(m, cfg, l, [...ledger, ev(ledger.length + 1, "core.forfeit", { by, reason })]));
            const label = `${m.key} ${name} by ${by === "both" ? "both" : "one side"} ${reason}`;
            expect(code === null, `${label}: admission ${says}, guard ${code ?? "records it"}`).toBe(says);
            if (!says) expect(code, label).toBe("FORFEIT_REASON_WRONG_PHASE");
            judged++;
            if (says) admitted++;
          }
        }
      }
    });
    expect(judged, `forfeits judged: ${judged} (${admitted} admitted)`).toBe(builtinModules.length * 5 * 5);
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(judged);
  });

  it("X-RS-1 (rulings 112, 113): the admission after a bare start is the rulings' — walkover, disqualified, withdrew, and Neither; after play, the module's own phase", () => {
    // Typed from the rulings: a walkover reads "pre" while nothing is played (both sides too), a disqualification is
    // recordable once Start is pressed (R4), a retirement only once something is played (ruling 113); withdrew in every
    // phase (R5).
    let checked = 0;
    forEachSport(({ module: m }) => {
      const { cfg, l, played } = playedScene(m);
      const bare = forfeitAdmission(m as never, fold(m, cfg, l, [START()]).state, { playRecorded: false });
      expect(bare, `${m.key} bare start`).toEqual({ phase: "play", reasons: ["walkover", "disqualified", "withdrew"], both: true });
      const state = fold(m, cfg, l, [START(), played]).state;
      const phase = m.forfeitPhase(state);
      const after = forfeitAdmission(m as never, state, { playRecorded: true });
      const walkover = walkoverPhasesOf(m).includes(phase);
      expect(after, `${m.key} after ${played.type}`).toEqual({
        phase,
        reasons: FORFEIT_REASONS.filter((r) => (r === "walkover" ? walkover : true)),
        both: walkover && phase !== "tiebreak",
      });
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });
});

describe("ruling 112: the stored production and staging walkovers", () => {
  // The exact stored shape: `core.start` at seq 1 with an empty payload, then `core.forfeit` at seq 2 whose `by` is the
  // absent side's entrant id (a uuid) and whose reason is "walkover"; nothing in between, nothing voided. Production
  // (fixture 069dbf22…) is a racket sport; staging (seazn_club, d26fca49…) is football. The entrant, event and recorder
  // ids are shaped like the stored rows (uuids); the values are this test's own.
  const rows = [
    { where: "production", sport: "badminton", fixtureId: "069dbf22-0000-4000-8000-000000000001" },
    { where: "staging", sport: "football", fixtureId: "d26fca49-0000-4000-8000-000000000002" },
  ] as const;

  it("X-RS-1 (ruling 112): the stored production walkover still folds", () => {
    let checked = 0;
    for (const row of rows) {
      const m = builtinModules.find((x) => x.key === row.sport)!;
      const cfg = firstCfg(m);
      const home = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";
      const away = "a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d";
      const l: LineupPair = { home: lineupFromCatalog(m.positions, home), away: lineupFromCatalog(m.positions, away) };
      const recordedBy = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a";
      const stored: EventEnvelope[] = [
        { id: "11111111-2222-4333-8444-555555555555", fixtureId: row.fixtureId, seq: 1, type: "core.start", payload: {}, recordedAt: "2026-10-04T09:00:00.000Z", recordedBy },
        { id: "66666666-7777-4888-8999-aaaaaaaaaaaa", fixtureId: row.fixtureId, seq: 2, type: "core.forfeit", payload: { by: away, reason: "walkover" }, recordedAt: "2026-10-04T09:15:00.000Z", recordedBy },
      ];
      // The read every page does (replay), and the write that stored it (strict from seq 2).
      for (const opts of [undefined, { strictFromSeq: 2 }]) {
        const f = foldMatchWithStoppage(m as never, cfg as never, l, stored, opts);
        expect(outcomeOf(m as never, f as never), `${row.where} ${row.sport} ${opts ? "write" : "replay"}`).toEqual({ kind: "award", winner: home, loser: away, reason: "walkover" });
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});
