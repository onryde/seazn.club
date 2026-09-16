// Owner decision 2026-09-16, review m2 — one margin shape from
// `GET /api/v1/fixtures/{id}/state`.
//
// That endpoint serves `match_states.state` / `.summary`, a fold CACHE that is
// rewritten only when the fixture's ledger is next appended to. A cricket
// fixture decided before the margin became structured still holds the English
// words the engine used to write ("by 12 runs") in `state.margin` and
// `summary.detail.margin`, beside newer rows holding `{ kind, value? }` under
// the same field. `getFixtureState` normalises on read.
//
// The stored rows below are REAL folds with only the margin put back into the
// old words (the `legacyWords` oracle is HEAD's `decideWin` templates,
// verbatim), JSON round-tripped the way jsonb returns them. The row a real
// fold writes today is the expected read-back, so a template the oracle and
// the parser disagree on fails here rather than passing on a hand-typed shape.
//
// `withTenant` is mocked because the thing under test is the read path's
// mapping, not Postgres: no DATABASE_URL is needed, so this runs everywhere.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { withTenantMock } = vi.hoisted(() => ({ withTenantMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ withTenant: withTenantMock, sql: {} }));

import { cricket, type CricketMargin, type CricketState } from "@seazn/engine/sports/cricket";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  SUPER_OVER_SCRIPT,
  scriptLedger,
  summaryOnlyLedger,
  type ScriptLedger,
} from "@/server/public-site/__tests__/cricket-ledger";
import { fixtureStateEtag, getFixtureState } from "../fixtures";
import { structuredCricketMargin } from "../stored-cricket-margin";

const auth = { orgId: "org-1", via: "session", userId: "u-1", role: "owner", keyId: null } as unknown as AuthCtx;

/** HEAD's `decideWin` margin strings, verbatim — the only five the engine ever wrote. */
function legacyWords(margin: CricketMargin): string {
  switch (margin.kind) {
    case "runs":
      return `by ${margin.value} run${margin.value === 1 ? "" : "s"}`;
    case "wickets":
      return `by ${margin.value} wicket${margin.value === 1 ? "" : "s"}`;
    case "innings_and_runs":
      return `by an innings and ${margin.value} run${margin.value === 1 ? "" : "s"}`;
    case "super_over":
      return "Super Over";
    case "boundary_count":
      return "on boundary count";
  }
}

const jsonb = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface StoredRow {
  status: string;
  outcome: unknown;
  sport_key: string;
  last_seq: number | null;
  state: unknown;
  summary: unknown;
}

/** The row a fold writes TODAY, and the same row as a pre-change write left it. */
function rows(ledger: ScriptLedger): { fresh: StoredRow; legacy: StoredRow; margin: CricketMargin } {
  const state: CricketState = ledger.state;
  if (state.margin === null) throw new Error("fixture must be a decided win with a margin");
  const summary = cricket.summary(state);
  const fresh: StoredRow = jsonb({
    status: "completed",
    outcome: state.outcome,
    sport_key: "cricket",
    last_seq: ledger.events.length - 1,
    state,
    summary,
  });
  const words = legacyWords(state.margin);
  const legacy: StoredRow = jsonb({
    ...fresh,
    state: { ...state, margin: words },
    summary: { ...summary, detail: { ...(summary.detail as object), margin: words } },
  });
  return { fresh, legacy, margin: state.margin };
}

function serve(row: StoredRow | undefined): void {
  withTenantMock.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => {
    const tx = async () => (row === undefined ? [] : [row]);
    return fn(tx);
  });
}

const TWO_INNINGS = { ...cricket.variants.test, playersPerSide: 8 };

// Each ledger is asserted against its margin below, so a script that stops
// folding to the kind it is named for fails loudly instead of testing another.
const CASES: readonly { name: string; ledger: () => ScriptLedger; margin: CricketMargin }[] = [
  {
    name: "by 1 run",
    ledger: () => summaryOnlyLedger([{ runs: 6, wickets: 0, legalBalls: 12 }, { runs: 5, wickets: 2, legalBalls: 12 }]),
    margin: { kind: "runs", value: 1 },
  },
  {
    name: "by 21 runs",
    ledger: () => summaryOnlyLedger([{ runs: 26, wickets: 0, legalBalls: 12 }, { runs: 5, wickets: 2, legalBalls: 12 }]),
    margin: { kind: "runs", value: 21 },
  },
  {
    name: "by 1 wicket",
    ledger: () => summaryOnlyLedger([{ runs: 6, wickets: 1, legalBalls: 12 }, { runs: 7, wickets: 6, legalBalls: 10 }]),
    margin: { kind: "wickets", value: 1 },
  },
  {
    name: "by 0 wickets",
    ledger: () => summaryOnlyLedger([{ runs: 6, wickets: 1, legalBalls: 12 }, { runs: 7, wickets: 7, legalBalls: 10 }]),
    margin: { kind: "wickets", value: 0 },
  },
  {
    name: "by an innings and 1 run",
    ledger: () =>
      summaryOnlyLedger(
        [
          { runs: 100, wickets: 7, legalBalls: 300 },
          { runs: 300, wickets: 7, legalBalls: 400 },
          { runs: 199, wickets: 7, legalBalls: 300 },
        ],
        { cfg: TWO_INNINGS },
      ),
    margin: { kind: "innings_and_runs", value: 1 },
  },
  { name: "Super Over", ledger: () => scriptLedger(SUPER_OVER_SCRIPT), margin: { kind: "super_over" } },
];

describe("getFixtureState — a pre-2026-09-16 cricket row serves the structured margin", () => {
  beforeEach(() => {
    withTenantMock.mockReset();
  });

  it.each(CASES)("an OLD row margined $name reads back identical to today's fold", async ({ ledger, margin }) => {
    const { fresh, legacy, margin: folded } = rows(ledger());
    expect(folded).toEqual(margin);
    // Not vacuous: the stored row really is the old shape in BOTH places.
    expect((legacy.state as { margin: unknown }).margin).toBe(legacyWords(margin));
    expect((legacy.summary as { detail: { margin: unknown } }).detail.margin).toBe(legacyWords(margin));

    serve(legacy);
    const out = await getFixtureState(auth, "fx-1");
    expect(out.state).toEqual(fresh.state);
    expect(out.summary).toEqual(fresh.summary);
    expect(out.last_seq).toBe(fresh.last_seq);
    expect(out.outcome).toEqual(fresh.outcome);
  });

  it("a row already in the new shape is served as stored", async () => {
    const { fresh } = rows(scriptLedger(SUPER_OVER_SCRIPT));
    serve(fresh);
    const out = await getFixtureState(auth, "fx-1");
    expect(out.state).toEqual(fresh.state);
    expect(out.summary).toEqual(fresh.summary);
  });

  it("another sport's state is never rewritten, even with a field that looks like an old margin", async () => {
    const row: StoredRow = {
      status: "completed",
      outcome: { kind: "win", winner: "e-1" },
      sport_key: "football",
      last_seq: 3,
      state: { margin: "by 3 runs" },
      summary: { headline: "3–0", detail: { margin: "by 3 runs" } },
    };
    serve(jsonb(row));
    const out = await getFixtureState(auth, "fx-1");
    expect(out.state).toEqual({ margin: "by 3 runs" });
    expect(out.summary).toEqual({ headline: "3–0", detail: { margin: "by 3 runs" } });
  });

  it("an unscored fixture (no match_states row) still reads as nulls", async () => {
    serve({ status: "scheduled", outcome: null, sport_key: "cricket", last_seq: null, state: null, summary: null });
    const out = await getFixtureState(auth, "fx-1");
    expect(out).toEqual({ fixture_id: "fx-1", status: "scheduled", last_seq: 0, state: null, summary: null, outcome: null });
  });

  it("a missing fixture is still a 404", async () => {
    serve(undefined);
    await expect(getFixtureState(auth, "fx-1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("structuredCricketMargin — the five strings the engine ever wrote", () => {
  it.each([
    ["by 1 run", { kind: "runs", value: 1 }],
    ["by 133 runs", { kind: "runs", value: 133 }],
    ["by 1 wicket", { kind: "wickets", value: 1 }],
    ["by 0 wickets", { kind: "wickets", value: 0 }],
    ["by an innings and 1 run", { kind: "innings_and_runs", value: 1 }],
    ["by an innings and 57 runs", { kind: "innings_and_runs", value: 57 }],
    ["Super Over", { kind: "super_over" }],
    ["on boundary count", { kind: "boundary_count" }],
  ] as const)("'%s' -> %j", (words, margin) => {
    expect(structuredCricketMargin(words)).toEqual(margin);
  });

  it("anything else is no margin at all — never a second shape under the field", () => {
    for (const junk of ["", "by runs", "by 12", "won by 12 runs", "by 1 runs and more", "super over"]) {
      expect(structuredCricketMargin(junk)).toBeNull();
    }
  });
});

describe("fixtureStateEtag — the representation moved, so the validator did", () => {
  it("never matches a pre-change `\"seq-N\"`, and still moves with the ledger", () => {
    expect(fixtureStateEtag(7)).not.toBe('"seq-7"');
    expect(fixtureStateEtag(7)).toMatch(/^"seq-7[^0-9]/);
    expect(fixtureStateEtag(8)).not.toBe(fixtureStateEtag(7));
  });
});
