// Spectator surface W1, Task 6 — `buildMatchCentre` (cricket view model).
// See the brief and contract notes at
// `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/task-6-{brief,
// contract-notes}.md` in the orchestrator's worktree for the rulings this
// suite follows (bare dictionary keys, `derivedComplete`, masking, top
// performers, the exact margin-string shapes `parseMargin` in `match-centre.ts`
// is pinned against).
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, deriveCricketScorecard, type DismissalKind } from "@seazn/engine/sports/cricket";
import { FootballCfg } from "@seazn/engine/sports/football";
import {
  BALL_GLYPH_KINDS,
  DISMISSAL_KINDS,
  RESULT_KINDS,
  buildMatchCentre,
  dismissalMsg,
  fmt1,
  fmt2,
  type MatchCentreInput,
} from "../match-centre";
import type { PublicFixture } from "../data";
import type { PublicPerson } from "../public-lineups";
import type { PersonT, SideT } from "../match-centre-schema";
import {
  AWAY,
  HOME,
  SUPER_OVER_SCRIPT,
  TIE_NO_SUPER_OVER,
  lineLedger,
  scriptLedger,
  type PlayerLine,
  type Script,
  type ScriptLedger,
} from "./cricket-ledger";

// --------------------------------------------------------------- fixtures

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "fx1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "home",
  away_entrant_id: "away",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: "Central Park",
  court_name: "Court 1",
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const HOME_SIDE: SideT = { entrantId: "home", name: "Home Blazers", short: "HOM", colour: null, badgeUrl: null };
const AWAY_SIDE: SideT = { entrantId: "away", name: "Southend Queens", short: "SEQ", colour: null, badgeUrl: null };
const SIDES: [SideT, SideT] = [HOME_SIDE, AWAY_SIDE];

function lineupsFrom(homeIds: readonly string[], awayIds: readonly string[]): Record<string, PublicPerson[]> {
  const person = (id: string): PublicPerson => ({ personId: id, name: `Player ${id.toUpperCase()}`, masked: false });
  return { home: homeIds.map(person), away: awayIds.map(person) };
}

const FULL_NAME_OF_H1 = "Player H1";
const MASKED_NAME_OF_H1 = "H. Redacted";

function lineupsWithOneMasked(id: string): Record<string, PublicPerson[]> {
  const base = lineupsFrom(HOME, AWAY);
  return {
    ...base,
    home: base.home.map((p) => (p.personId === id ? { personId: id, name: MASKED_NAME_OF_H1, masked: true } : p)),
  };
}

function input(over: Partial<MatchCentreInput> = {}): MatchCentreInput {
  return {
    fixture: F({}),
    sportKey: "cricket",
    cfg: cricket.configSchema.parse({}),
    events: [],
    lineups: lineupsFrom(HOME, AWAY),
    sides: SIDES,
    venueTz: "UTC",
    locale: "en",
    now: new Date("2026-09-25T10:00:00.000Z"),
    hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: null,
    ...over,
  };
}

/** A decided fixture's own `outcome`/`summary`, read off the SAME reducer
 *  state the ledger produced — never hand-typed, so a script change moves
 *  the expectation with it (standing rule: derive from the source of truth). */
function decidedFixture(ledger: ScriptLedger, extra: Partial<PublicFixture> = {}): PublicFixture {
  return F({
    status: "decided",
    outcome: ledger.state.outcome as PublicFixture["outcome"],
    summary: cricket.summary(ledger.state),
    ...extra,
  });
}

// ----------------------------------------------------------------- scripts

const CHASE_SCRIPT: Script = {
  cfg: { ballsPerInnings: 12, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      batting: "home",
      bowlers: ["a7", "a6"],
      deliveries: [{ bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }],
    },
    {
      batting: "away",
      bowlers: ["h7"],
      deliveries: [{ bat: 1 }, { bat: 1 }, { bat: 2 }, { bat: 0 }, { bat: 1 }],
      leaveOpen: true,
    },
  ],
};

// Home 24 off 6 (all boundaries — h1 never rotates off strike, so he both
// scores heavily AND, in the second innings, bowls the wicket ball below —
// exactly the two categories (batting + bowling-credit) the masking test
// needs one person to appear in). Away collapse for 0/1 in reply: NOT a
// tie (0 !== target-1 = 24), so `decideWin(home, "regulation", "by 24 runs")`.
const DECIDED_BY_RUNS_SCRIPT: Script = {
  cfg: { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }] },
    {
      batting: "away",
      bowlers: ["h1"],
      deliveries: [
        { bat: 0 },
        { out: "caught", fielder: "h2", bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
      ],
    },
  ],
};

// Home 6 off 6 (all singles). Away reach the target (7) on the fourth ball
// with all ten wickets in hand: `decideWin(away, "regulation", "by 7
// wickets")`. Only 4 deliveries scripted deliberately — the innings
// auto-closes the instant the target is reached, so a 5th would throw
// "no innings in progress".
const WIN_BY_WICKETS_SCRIPT: Script = {
  cfg: { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }] },
    { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 2 }, { bat: 2 }, { bat: 2 }, { bat: 1 }] },
  ],
};

// Band 2 (line ledger), enriched with 4s/6s/dismissal on the batting side and
// maidens/wides/noBalls on the bowling side (owner ruling 12 / Task 17) — two
// batters with EQUAL runs but different strike rate, two bowlers with EQUAL
// wickets but different economy, so the SAME fixture proves both the "real
// kind key reaches the doc" requirement and top performers' tie-break.
const TOP_PERFORMER_TOTALS = { runs: 80, wickets: 4, legalBalls: 48, partial: true };
const TOP_PERFORMER_LINES: readonly PlayerLine[] = [
  { innings: 1, person: "h1", batting: { runs: 40, balls: 20, out: true, fours: 5, sixes: 1, dismissal: { kind: "caught", bowler: "a7", fielder: "a3" } } },
  { innings: 1, person: "h2", batting: { runs: 40, balls: 40, out: true } },
  { innings: 1, person: "a7", bowling: { legalBalls: 24, runs: 12, wickets: 2, maidens: 1, wides: 1, noBalls: 0 } },
  { innings: 1, person: "a6", bowling: { legalBalls: 24, runs: 24, wickets: 2 } },
];

// ------------------------------------------------------------------ tests

describe("buildMatchCentre — cricket", () => {
  it("EMPTY ledger: header says scheduled, tabs are summary + info only, cricket view has no innings", () => {
    const doc = buildMatchCentre(input({ events: [], fixture: F({ status: "scheduled" }) }));
    expect(doc.tabs).toEqual(["summary", "info"]);
    expect(doc.header.status).toBe("scheduled");
    expect(doc.cricket?.innings).toEqual([]);
  });

  it("band 3 live: tabs are summary, scorecard, commentary, info in that ORDER; header carries the chase line", () => {
    const ledger = scriptLedger(CHASE_SCRIPT);
    const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
    const doc = buildMatchCentre(
      input({
        events: ledger.events,
        cfg: ledger.cfg,
        fixture: F({ status: "in_play", summary: cricket.summary(ledger.state) }),
      }),
    );
    expect(doc.tabs).toEqual(["summary", "scorecard", "commentary", "info"]);
    expect(doc.header.live).toBe(true);
    expect(card.live).not.toBeNull();
    expect(doc.header.statusLine).toEqual({
      key: "matchCentre.chase.need",
      params: { side: AWAY_SIDE.name, runs: card.live!.needRuns, balls: card.live!.ballsLeft },
    });
    expect(doc.header.rateLine).toMatch(/^CRR \d+\.\d\d · RRR \d+\.\d\d$/);
    expect(doc.header.rateLine).toBe(`CRR ${fmt2(card.live!.crr!)} · RRR ${fmt2(card.live!.rrr!)}`);
  });

  it("band 2: no commentary tab; dismissal is out_unknown key; 4s/6s null", () => {
    const ledger = lineLedger();
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg }));
    expect(doc.tabs).toEqual(["summary", "scorecard", "info"]);
    const bat = doc.cricket!.innings[0]!.batting[0]!;
    expect(bat.dismissal).toEqual({ key: "matchCentre.dismissal.out_unknown" });
    expect(bat.fours).toBeNull();
    expect(bat.sixes).toBeNull();
  });

  it("band 2 ENRICHED: a line with fours/sixes/dismissal/maidens/wides/noBalls reaches the doc with the real kind key and the numbers", () => {
    const ledger = lineLedger(TOP_PERFORMER_TOTALS, TOP_PERFORMER_LINES);
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg }));
    const bat = doc.cricket!.innings[0]!.batting.find((b) => b.person.personId === "h1")!;
    expect(bat.fours).toBe(5);
    expect(bat.sixes).toBe(1);
    expect(bat.dismissal.key).toBe("matchCentre.dismissal.caught");
    const bowl = doc.cricket!.innings[0]!.bowling.find((b) => b.person.personId === "a7")!;
    expect(bowl.maidens).toBe(1);
    expect(bowl.wides).toBe(1);
    expect(bowl.noBalls).toBe(0);
  });

  it("a masked person is masked EVERYWHERE the name appears: batting, bowling, fall of wickets, partnerships, commentary, top performers", () => {
    const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
    const doc = buildMatchCentre(
      input({
        events: ledger.events,
        cfg: ledger.cfg,
        lineups: lineupsWithOneMasked("h1"),
        fixture: decidedFixture(ledger),
      }),
    );
    const json = JSON.stringify(doc);
    expect(json).not.toContain(FULL_NAME_OF_H1);
    expect(json).toContain(MASKED_NAME_OF_H1); // positive pair
  });

  it("every dismissal kind the engine declares maps to a dictionary key", () => {
    const names = (id: string): PersonT => ({ personId: id, name: id, masked: false });
    const realKinds = DISMISSAL_KINDS.filter(
      (k): k is Exclude<(typeof DISMISSAL_KINDS)[number], "not_out" | "out_unknown"> =>
        k !== "not_out" && k !== "out_unknown",
    );
    expect(realKinds).toHaveLength(10);
    for (const kind of realKinds as readonly DismissalKind[]) {
      expect(dismissalMsg({ kind, bowler: "b", fielder: "f", fielderAssist: null }, names).key).toBe(
        `matchCentre.dismissal.${kind}`,
      );
    }
  });

  it("top performers: best batter by runs then strike rate; best bowler by wickets then economy — with an ORDER-differential case", () => {
    const ledger = lineLedger(TOP_PERFORMER_TOTALS, TOP_PERFORMER_LINES);
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg }));
    const performers = doc.cricket!.topPerformers;
    const batter = performers.find((p) => p.role === "batter")!;
    const bowler = performers.find((p) => p.role === "bowler")!;
    // h1 and h2 both scored 40 — h1's strike rate (200.0, 40/20) beats h2's
    // (100.0, 40/40); a mutant swapping the tie-break direction picks h2.
    expect(batter.person.personId).toBe("h1");
    expect(batter.detail).toBe(`SR ${fmt1(200)}`);
    // a7 and a6 both took 2 wickets — a7's economy (3.0, 12 runs/24 balls at
    // this cfg's ballsPerOver) beats a6's (6.0); a mutant swapping the
    // tie-break direction picks a6.
    expect(bowler.person.personId).toBe("a7");
    expect(bowler.detail).toBe(`Econ ${fmt1(3)}`);
  });

  it("final: header status decided, statusLine is the result key with the margin params, live null", () => {
    const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
    expect(doc.header.status).toBe("decided");
    // Ruling: keys are BARE, never `public.`-prefixed — the brief's own
    // `/^public\.matchCentre\.result\./` regex is the stale one.
    expect(doc.header.statusLine?.key).toMatch(/^matchCentre\.result\./);
    expect(doc.cricket!.live).toBeNull();
  });

  describe("decided — every required result kind is reachable", () => {
    it("win by runs -> matchCentre.result.runs, {side, runs}", () => {
      const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine).toEqual({
        key: "matchCentre.result.runs",
        params: { side: HOME_SIDE.name, runs: 24 },
      });
    });

    it("win by wickets -> matchCentre.result.wickets, {side, wickets}", () => {
      const ledger = scriptLedger(WIN_BY_WICKETS_SCRIPT);
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine).toEqual({
        key: "matchCentre.result.wickets",
        params: { side: AWAY_SIDE.name, wickets: 7 },
      });
    });

    it("tie (no super over) -> matchCentre.result.tie, no params", () => {
      const ledger = scriptLedger(TIE_NO_SUPER_OVER);
      expect(ledger.state.outcome).toEqual({ kind: "tie" });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine).toEqual({ key: "matchCentre.result.tie" });
    });

    it("a decided super over -> matchCentre.result.superover", () => {
      const ledger = scriptLedger(SUPER_OVER_SCRIPT);
      expect(ledger.state.margin).toBe("Super Over");
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine?.key).toBe("matchCentre.result.superover");
      expect(typeof doc.header.statusLine?.params?.side).toBe("string");
      expect(doc.header.statusLine?.params?.side).not.toBe("");
    });
  });

  it("derivedComplete: false when the non-cricket derived pass hits an event the module refuses; the document carries the flag", () => {
    const footballCfg = FootballCfg.parse({});
    const events: EventEnvelope[] = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "football.nonsense", payload: {} }),
    ];
    const doc = buildMatchCentre(
      input({
        sportKey: "football",
        cfg: footballCfg,
        events,
        fixture: F({ status: "in_play", home_entrant_id: "home", away_entrant_id: "away" }),
      }),
    );
    expect(doc.derivedComplete).toBe(false);
    // The RECORDED pass never touches the module — the line for the event the
    // module refuses still renders (Task 7's own contract).
    expect(doc.timeline).not.toBeNull();
    expect(doc.timeline!.length).toBe(2);
  });

  it("exports the three key-coverage arrays Task 8 checks the dictionaries against", () => {
    expect(DISMISSAL_KINDS).toContain("bowled");
    expect(DISMISSAL_KINDS).toContain("not_out");
    expect(DISMISSAL_KINDS).toContain("out_unknown");
    expect(RESULT_KINDS).toContain("runs");
    expect(RESULT_KINDS).toContain("wickets");
    expect(RESULT_KINDS).toContain("tie");
    expect(RESULT_KINDS).toContain("superover");
    expect(BALL_GLYPH_KINDS).toContain("wicket");
    expect(BALL_GLYPH_KINDS).toContain("runs");
  });
});
