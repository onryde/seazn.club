// REAL folded cricket states, the sibling of _football-fold.ts and for the
// same reason: R3 shipped four dead-end paths past green tests because those
// tests asserted the SKIN against a mirror of the engine. A mirror agrees
// with itself. Every assertion built on this file compares the skin to a
// state `foldMatch` actually produced.
//
// Leading underscore = helper, not a suite; vitest's `*.test.ts` include
// never picks it up, the same convention `../../__tests__/_cfg-space.ts` and
// `_football-fold.ts` already use.
import { foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";

/** Eleven per side, batting order = orderNo — the SAME shape the engine's own
 *  `cricket.test.ts` builds its lineups with (`function lineup`), so a state
 *  folded here is never disqualified by a lineup shape the fold would refuse
 *  in production. */
export function cricketLineups(): LineupPair {
  const side = (p: string): LineupPair["home"] => ({
    entrantId: p,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${p}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  });
  return { home: side("H"), away: side("A") };
}

// Third tuple slot mirrors the engine's own `cricket.test.ts` `stream()`
// helper: a `core.void`'s target travels in `EventEnvelope.voids`, never the
// payload (`CoreVoid = z.strictObject({})`) — needed for C22 (voiding the
// last super-over ball). `makeEnvelope`'s ids are the deterministic
// `e-${seq}` (testkit/helpers.ts), so a void target is simply `e-${n}` for
// the nth event (0-indexed) in the SAME specs array passed to both functions
// below.
export type CricketEventSpec = readonly [type: string, payload?: unknown, voids?: string];

/** The envelopes `foldCricket` folds, exposed standalone so a test that also
 *  needs `PadHostView.events` (`freeHitPending`/`overDots` both read the raw
 *  event log, not the folded state) can pass the SAME list rather than a
 *  second, possibly-diverging one. */
export function cricketEnvelopes(specs: readonly CricketEventSpec[]): EventEnvelope[] {
  return specs.map(([type, payload, voids], i) =>
    makeEnvelope(i, { type, payload: payload ?? {} }, voids));
}

export function foldCricket(cfg: CricketCfg, specs: readonly CricketEventSpec[]): CricketState {
  return foldMatch(cricket, cfg, cricketLineups(), cricketEnvelopes(specs));
}

/** A ball payload builder that keeps (over, ballInOver) honest across a
 *  sequence — an illegal delivery repeats the ball number, which is what the
 *  fold expects and what a hand-written literal reliably gets wrong. One
 *  instance per INNINGS (main or super-over): `over`/`ballInOver` are only
 *  checked against the fold's ledger under a strict fold (`foldCricket` above
 *  never sets `strictFromSeq`, so this repo's non-strict replay would not
 *  itself catch a counter carried across an innings boundary) — kept
 *  per-innings anyway so a payload's `over` numbering is never misleading to
 *  a reader of the test, and so a future strict-fold caller of this same
 *  helper is not quietly wrong. */
export function ballSeq(bpo = 6) {
  let legal = 0;
  return (type: string, p: {
    striker: string; nonStriker: string; bowler: string;
    bat?: number; boundary?: 4 | 6; extras?: { kind: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number };
    wicket?: unknown;
  }): [string, unknown] => {
    const payload = {
      over: Math.floor(legal / bpo), ballInOver: (legal % bpo) + 1,
      striker: p.striker, nonStriker: p.nonStriker, bowler: p.bowler,
      runs: { bat: p.bat ?? 0, ...(p.extras ? { extras: p.extras } : {}) },
      ...(p.wicket ? { wicket: p.wicket } : {}),
      ...(p.boundary ? { boundary: p.boundary } : {}),
    };
    const illegal = p.extras?.kind === "wide" || p.extras?.kind === "noball";
    if (!illegal) legal++;
    return [type, payload];
  };
}

/** A tied one-over-a-side T20 with the super over enabled — the shortest
 *  legal route to `phase: "super_over"`. `minOversForResult: 1` is required:
 *  the cfg refine rejects a result floor longer than the innings. */
export function tiedWithSuperOver(overrides: Record<string, unknown> = {}): CricketCfg {
  return cricket.configSchema.parse({
    superOver: true, ballsPerInnings: 6, ballsPerOver: 6, minOversForResult: 1, ...overrides,
  });
}
