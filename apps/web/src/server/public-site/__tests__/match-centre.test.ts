// Spectator surface W1, Task 6 — `buildMatchCentre` (cricket view model).
// See the brief and contract notes at
// `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/task-6-{brief,
// contract-notes}.md` in the orchestrator's worktree for the rulings this
// suite follows (bare dictionary keys, `derivedComplete`, masking, top
// performers). Fix round 1 rulings (post-review, see `task-6-report.md`'s
// "Fix round 1" section): result keys come from `outcome.method` with the
// margin string passed through verbatim (never regex-parsed), the
// non-cricket branch resolves a PINNED `moduleVersion`, and the Info tab
// emits its six rows in `info-tab.tsx`'s documented order.
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { registry as engineRegistry, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { cricket, deriveCricketScorecard, type DismissalKind } from "@seazn/engine/sports/cricket";
import { football, FootballCfg } from "@seazn/engine/sports/football";
import { tennis } from "@seazn/engine/sports/tennis";
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
import type { MsgT, PersonT, SideT } from "../match-centre-schema";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import enPublic from "@/dictionaries/en/public.json";
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
    moduleVersion: null,
    formatLabel: null,
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

/** Fix round 2 — the "scoredAs" expectation, derived from the SAME module
 *  declaration `effectiveBand` (`match-centre.ts`) reads, never a hand-typed
 *  number: the max fidelity band any event TYPE in the ledger declares,
 *  per the module's own `padSpec(cfg).fidelity`. */
function declaredBand(sportModule: AnySportModule, cfg: unknown, events: readonly EventEnvelope[]): number {
  const bands = sportModule.padSpec?.(cfg)?.fidelity ?? {};
  return events.reduce((max, ev) => Math.max(max, bands[ev.type] ?? 0), 0);
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

// The match is abandoned before a ball is bowled: `openInnings`/`chase` are
// both null (no innings created yet), `cfg.inningsPerSide` is the default 1
// (not 2, so this isn't a draw), and DLS is off — `applyAbandon` falls
// straight to its final `{ kind: "no_result" }` branch (`cricket.ts:1120`).
const NO_RESULT_SCRIPT: Script = {
  cfg: { ballsPerInnings: 12, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ abandon: true }] }],
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

  // Review round 1, Important #2 — `SUPER_OVER_SCRIPT` has FOUR innings
  // cards (main 1, main 2, super-over 3, super-over 4 — the engine's own
  // `cards()` numbers super-over cards `state.innings.length + i`, i.e.
  // continuing the count, `scorecard.ts:698-700`), and its bowler lists
  // deliberately reuse the SAME person: `a7` bowls innings 1 (main) AND
  // innings 4 (the super over's home-reply); `h7` bowls innings 2 (main)
  // AND innings 3 (the super over's away-batting). Each of those four
  // innings has exactly ONE bowler, so that bowler is trivially "best" in
  // each — this is the exact shape the pre-fix `.find()`-based lookup in
  // `summary-tab.tsx` could not tell apart: a person credited in TWO
  // innings used to collapse to whichever one `.find()` reached first
  // (always the main one). `topPerformersOf` now carries the innings
  // number out at the point of selection, so it must produce TWO SEPARATE
  // entries per person, each with its OWN (different) innings number — a
  // fixture where the two numbers happened to agree could not witness this
  // regression, which is why this uses the super over, not `groupedPerformersDoc`.
  it("top performers: a bowler credited in BOTH a main innings and the super over gets two entries with their OWN, DIFFERENT innings numbers", () => {
    const ledger = scriptLedger(SUPER_OVER_SCRIPT);
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
    const performers = doc.cricket!.topPerformers;

    const a7Entries = performers.filter((p) => p.role === "bowler" && p.person.personId === "a7");
    expect(a7Entries.length).toBe(2);
    expect(a7Entries.map((p) => p.innings).sort((x, y) => x - y)).toEqual([1, 4]);

    // Positive/negative pair on the same shape: h7 bowls innings 2 and 3 —
    // a DIFFERENT pair of numbers than a7's, so this cannot pass by
    // accidentally hardcoding a7's answer for both.
    const h7Entries = performers.filter((p) => p.role === "bowler" && p.person.personId === "h7");
    expect(h7Entries.length).toBe(2);
    expect(h7Entries.map((p) => p.innings).sort((x, y) => x - y)).toEqual([2, 3]);

    // Never collapsed to a single entry — the defect this test exists for
    // would have shown as `a7Entries.length === 2` (both pushed) but both
    // entries claiming the SAME (wrong) innings number had the mislabeling
    // lived in a re-derived lookup instead of the producer; asserting the
    // two DIFFER is the actual witness.
    expect(a7Entries[0]!.innings).not.toBe(a7Entries[1]!.innings);
    expect(h7Entries[0]!.innings).not.toBe(h7Entries[1]!.innings);
  });

  // A SHOOTOUT is football's and ice hockey's win method, not cricket's, and it
  // was missing from `WIN_METHODS` — so it fell through to `regulation`
  // ("{winner} won {margin}") with the margin read off the CRICKET card, which
  // is null for those sports. The court card printed "X won" with a blank
  // margin and "on penalties" appeared nowhere on the page, while the share
  // text (a different code path) had it right the whole time. 7 football and 1
  // ice hockey fixtures in one local database were in exactly that state.
  it("shootout win -> matchCentre.result.shootout with the tally from summary.detail", () => {
    const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
    const doc = buildMatchCentre(
      input({
        events: ledger.events,
        cfg: ledger.cfg,
        fixture: decidedFixture(ledger, {
          outcome: { kind: "win", winner: HOME_SIDE.entrantId, method: "shootout" } as PublicFixture["outcome"],
          summary: { headline: "", perSide: [], detail: { shootout: { home: 3, away: 0 } } } as never,
        }),
      }),
    );
    expect(doc.header.statusLine?.key).toBe("matchCentre.result.shootout");
    expect(doc.header.statusLine?.params?.winner).toBe(HOME_SIDE.name);
    // The en dash is `shootoutScoreFromDetail`'s house style, shared with
    // `live-score.tsx` so one match cannot read two ways on two surfaces.
    expect(doc.header.statusLine?.params?.margin).toBe("3–0");
  });

  // The tally can be absent (a trimmed projection, a coarse or replayed
  // summary). Falling back to the generic win line would drop "on penalties",
  // the ONE thing distinguishing this method — the same mistake
  // `scoring-vocab.ts`'s `shootoutPlain` exists to prevent, on a second
  // surface. Without this case the test above passes while the method is still
  // lost whenever the detail is missing.
  it("shootout win with NO tally -> matchCentre.result.shootoutPlain, never the generic win line", () => {
    const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
    const doc = buildMatchCentre(
      input({
        events: ledger.events,
        cfg: ledger.cfg,
        fixture: decidedFixture(ledger, {
          outcome: { kind: "win", winner: HOME_SIDE.entrantId, method: "shootout" } as PublicFixture["outcome"],
          summary: { headline: "", perSide: [], detail: {} } as never,
        }),
      }),
    );
    expect(doc.header.statusLine?.key).toBe("matchCentre.result.shootoutPlain");
    expect(doc.header.statusLine?.key).not.toBe("matchCentre.result.regulation");
    expect(doc.header.statusLine?.params?.winner).toBe(HOME_SIDE.name);
  });

  // The word for a shootout belongs to the SPORT. "Won on penalties" is
  // football's sentence; ice hockey and field hockey have a shootout, and the
  // engine already speaks that way (icehockey's metrics are "GWS goals" —
  // game-winning shots). One shared football-worded key was printing for every
  // sport, which only became visible once the shootout sentence reached the
  // court card at all. Asserted as a PAIR — football keeps its word, hockey
  // gets its own — because a test that only checked hockey would pass just as
  // happily if BOTH sports had been switched to the skated wording.
  it.each([
    ["football", "matchCentre.result.shootout"],
    ["icehockey", "matchCentre.result.shootoutHockey"],
    ["hockey", "matchCentre.result.shootoutHockey"],
  ])("a %s shootout uses that sport's own word (%s)", (sportKey, expectedKey) => {
    const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
    // Each sport's OWN default cfg, from its own module. Passing cricket's cfg
    // with a football `sportKey` resolves the football module and then crashes
    // inside its `padSpec` reading a key cricket's config has never heard of —
    // a harness fault whose stack looks exactly like a production one.
    // `builtinModules` rather than the shared `registry`: nothing registers the
    // built-ins in this test process (that happens at server boot), so
    // `registry.latest("football")` throws MODULE_NOT_FOUND here.
    const sportModule = builtinModules.find((m) => m.key === sportKey);
    expect(sportModule, `no built-in module for ${sportKey}`).toBeDefined();
    const sportCfg = sportModule!.configSchema.parse({});
    const doc = buildMatchCentre(
      input({
        events: [],
        cfg: sportCfg,
        sportKey,
        fixture: decidedFixture(ledger, {
          outcome: { kind: "win", winner: HOME_SIDE.entrantId, method: "shootout" } as PublicFixture["outcome"],
          summary: { headline: "", perSide: [], detail: { shootout: { home: 3, away: 2 } } } as never,
        }),
      }),
    );
    expect(doc.header.statusLine?.key).toBe(expectedKey);
    expect(doc.header.statusLine?.params?.margin).toBe("3–2");
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

  describe("decided — every required result kind is reachable, keyed by outcome.method (fix round 1)", () => {
    it("regulation win, runs margin -> matchCentre.result.regulation, {winner, margin} byte-for-byte", () => {
      const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
      const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
      expect(ledger.state.outcome).toMatchObject({ kind: "win", method: "regulation" });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine?.key).toBe("matchCentre.result.regulation");
      expect(doc.header.statusLine?.params?.winner).toBe(HOME_SIDE.name);
      expect(doc.header.statusLine?.params?.margin).toBe(card.result?.margin);
      expect(card.result?.margin).toBe("by 24 runs");
    });

    it("regulation win, wickets margin -> matchCentre.result.regulation, {winner, margin} byte-for-byte", () => {
      const ledger = scriptLedger(WIN_BY_WICKETS_SCRIPT);
      const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
      expect(ledger.state.outcome).toMatchObject({ kind: "win", method: "regulation" });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine?.key).toBe("matchCentre.result.regulation");
      expect(doc.header.statusLine?.params?.winner).toBe(AWAY_SIDE.name);
      expect(doc.header.statusLine?.params?.margin).toBe(card.result?.margin);
      expect(card.result?.margin).toBe("by 7 wickets");
    });

    it("a decided super over -> matchCentre.result.super_over, margin 'Super Over' verbatim", () => {
      const ledger = scriptLedger(SUPER_OVER_SCRIPT);
      const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
      expect(ledger.state.outcome).toMatchObject({ kind: "win", method: "super_over" });
      expect(ledger.state.margin).toBe("Super Over");
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine?.key).toBe("matchCentre.result.super_over");
      expect(doc.header.statusLine?.params?.margin).toBe(card.result?.margin);
      expect(card.result?.margin).toBe("Super Over");
      expect(doc.header.statusLine?.params?.winner).not.toBe("");
    });

    it("tie (no super over) -> matchCentre.result.tie, no params", () => {
      const ledger = scriptLedger(TIE_NO_SUPER_OVER);
      expect(ledger.state.outcome).toEqual({ kind: "tie" });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine).toEqual({ key: "matchCentre.result.tie" });
    });

    it("no_result (abandoned before a ball is bowled) -> matchCentre.result.no_result, no params", () => {
      const ledger = scriptLedger(NO_RESULT_SCRIPT);
      expect(ledger.state.outcome).toEqual({ kind: "no_result" });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture: decidedFixture(ledger) }));
      expect(doc.header.statusLine).toEqual({ key: "matchCentre.result.no_result" });
    });

    it("an unrecognised win method falls back to matchCentre.result.regulation, margin still carried", () => {
      const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
      const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
      const fixture = decidedFixture(ledger, {
        outcome: { ...(ledger.state.outcome as { kind: "win"; winner: string }), method: "some_future_method" },
      });
      const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, fixture }));
      expect(doc.header.statusLine?.key).toBe("matchCentre.result.regulation");
      expect(doc.header.statusLine?.params?.margin).toBe(card.result?.margin); // never silently dropped
    });
  });

  describe("moduleVersion (fix round 1 — Important #2)", () => {
    // Two versions of the SAME fake sport key registered directly into the
    // engine's shared registry (the one `resolveModule`/`resolveLatestModule`
    // both read) — the "latest" one deliberately throws on `init` so a test
    // can tell, from the OUTSIDE, which version actually ran: `derivedComplete`
    // only stays `true` if the PINNED, non-throwing version was used.
    const KEY = "football-moduleversion-test";
    engineRegistry.register({ ...football, key: KEY, version: "1.0.0" });
    engineRegistry.register({
      ...football,
      key: KEY,
      version: "9.9.9",
      init: () => {
        throw new Error("the LATEST module must never run when a moduleVersion is pinned");
      },
    });

    it("a pinned moduleVersion resolves THAT version, not latest", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: KEY,
          moduleVersion: "1.0.0",
          cfg: FootballCfg.parse({}),
          events: [makeEnvelope(0, { type: "core.start", payload: {} })],
          fixture: F({ status: "in_play" }),
        }),
      );
      expect(doc.derivedComplete).toBe(true);
    });

    it("moduleVersion: null falls back to resolveLatestModule", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: KEY,
          moduleVersion: null,
          cfg: FootballCfg.parse({}),
          events: [makeEnvelope(0, { type: "core.start", payload: {} })],
          fixture: F({ status: "in_play" }),
        }),
      );
      // Latest (9.9.9) throws on init -> the derived pass degrades.
      expect(doc.derivedComplete).toBe(false);
    });
  });

  describe("Info tab rows — order and omission (fix round 1 — Important #3)", () => {
    it("emits toss, format, venue, start, stage, scoredAs in that order when every fact is present", () => {
      const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
      const doc = buildMatchCentre(
        input({
          events: ledger.events,
          cfg: ledger.cfg,
          fixture: decidedFixture(ledger),
          formatLabel: "T20",
          stage: { name: "Group A", roundLabel: "Round 1" },
        }),
      );
      expect(doc.info.rows.map((r) => r.label.key)).toEqual([
        "matchCentre.info.toss",
        "matchCentre.info.format",
        "matchCentre.info.venue",
        "matchCentre.info.start",
        "matchCentre.info.stage",
        "matchCentre.info.scoredAs",
      ]);
      // Fix round 2 — derived from the module's OWN declaration
      // (`cricket.padSpec(cfg).fidelity`), never a typed number or the
      // fold's own `card.band` (the whole point of the unification).
      expect(doc.info.rows[5]!.value.key).toBe(`matchCentre.band.${declaredBand(cricket, ledger.cfg, ledger.events)}`);
    });

    it("omits format/venue/stage when their facts are null — never a blank row", () => {
      const ledger = scriptLedger(DECIDED_BY_RUNS_SCRIPT);
      const doc = buildMatchCentre(
        input({
          events: ledger.events,
          cfg: ledger.cfg,
          fixture: decidedFixture(ledger, { venue_name: null, court_name: null }),
          formatLabel: null,
          stage: null,
        }),
      );
      expect(doc.info.rows.map((r) => r.label.key)).toEqual([
        "matchCentre.info.toss",
        "matchCentre.info.start",
        "matchCentre.info.scoredAs",
      ]);
    });
  });

  describe("scoredAs / matchCentre.band.<n> — a universal SportModule concept (fix round 2)", () => {
    it("a football ledger with football.goal events yields matchCentre.band.<its declared band>", () => {
      const footballCfg = FootballCfg.parse({});
      const events: EventEnvelope[] = [
        makeEnvelope(0, { type: "core.start", payload: {} }),
        makeEnvelope(1, { type: "football.goal", payload: { by: "home" } }),
      ];
      const doc = buildMatchCentre(
        input({
          sportKey: "football",
          cfg: footballCfg,
          events,
          fixture: F({ status: "in_play" }),
        }),
      );
      const expectedBand = declaredBand(football, footballCfg, events);
      const scoredAs = doc.info.rows.find((r) => r.label.key === "matchCentre.info.scoredAs");
      expect(scoredAs?.value.key).toBe(`matchCentre.band.${expectedBand}`);
    });

    it("a football ledger with a HIGHER-band event (football.card) yields that band, not the band-0 fallback", () => {
      // Fix round 3 — the round-2 football.goal case declares band 0, the
      // SAME value the degenerate/fallback path (a wrong module, a dead
      // lookup) also produces, so it could not tell "correctly resolved
      // band 0" from "silently fell back to 0" apart. football.card declares
      // a real, non-zero band (`football.ts:2379`), so this case can only
      // pass if the non-cricket branch is genuinely reading the RESOLVED
      // module's own `padSpec(cfg).fidelity`.
      const footballCfg = FootballCfg.parse({});
      const events: EventEnvelope[] = [
        makeEnvelope(0, { type: "core.start", payload: {} }),
        makeEnvelope(1, { type: "football.card", payload: { by: "home", color: "yellow" } }),
      ];
      const doc = buildMatchCentre(
        input({ sportKey: "football", cfg: footballCfg, events, fixture: F({ status: "in_play" }) }),
      );
      const expectedBand = declaredBand(football, footballCfg, events);
      expect(expectedBand).toBeGreaterThan(0); // the case is meaningless otherwise
      const scoredAs = doc.info.rows.find((r) => r.label.key === "matchCentre.info.scoredAs");
      expect(scoredAs?.value.key).toBe(`matchCentre.band.${expectedBand}`);
    });

    it("a kernel-only ledger (no sport-specific event types) yields band 0", () => {
      const footballCfg = FootballCfg.parse({});
      const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} })];
      const doc = buildMatchCentre(
        input({ sportKey: "football", cfg: footballCfg, events, fixture: F({ status: "in_play" }) }),
      );
      const scoredAs = doc.info.rows.find((r) => r.label.key === "matchCentre.info.scoredAs");
      expect(scoredAs?.value.key).toBe("matchCentre.band.0");
    });

    it("an empty ledger omits the scoredAs row entirely (nothing was scored)", () => {
      const doc = buildMatchCentre(
        input({ sportKey: "football", cfg: FootballCfg.parse({}), events: [], fixture: F({ status: "scheduled" }) }),
      );
      expect(doc.info.rows.find((r) => r.label.key === "matchCentre.info.scoredAs")).toBeUndefined();
    });
  });

  // R11 fix round, C10 — the tennis court card showed the sets score
  // ("0 / 0") but dropped the LIVE games score of the set in progress
  // ("0-0"), which appeared only in the Summary tab's per-set breakdown
  // table below. The fix carries it into `header.subLines`, the schema's
  // OWN pre-existing "beside the score" slot (`match-centre-schema.ts`'s
  // comment: `subLines: … // "(8.0)" | null`) — never recomputed, read off
  // the SAME `setsView`/`setBreakdown` derivation the Summary tab's
  // `SetScoreboard` already reads.
  describe("header.subLines — the live games score beside a set-based sport's score (R11 fix round, C10)", () => {
    it("a tennis fixture with an OPEN (unclosed) set carries that set's games score per side, in parens", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: "tennis",
          cfg: tennis.configSchema.parse({}),
          events: [],
          fixture: F({
            status: "in_play",
            summary: {
              headline: "0 — 0 (2–1)",
              perSide: [
                { entrantId: "home", line: "0" },
                { entrantId: "away", line: "0" },
              ],
              detail: { sets: [{ home: 2, away: 1, closed: false }] },
            },
          }),
        }),
      );
      expect(doc.header.subLines).toEqual(["(2)", "(1)"]);
      // Positive pair — the SETS score is untouched, still the sets-won line.
      expect(doc.header.scoreLines).toEqual(["0", "0"]);
    });

    it("a tennis fixture with EVERY set closed (no live set in progress) carries no subLine — nothing to show", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: "tennis",
          cfg: tennis.configSchema.parse({}),
          events: [],
          fixture: F({
            status: "decided",
            summary: {
              headline: "2 — 0",
              perSide: [
                { entrantId: "home", line: "2" },
                { entrantId: "away", line: "0" },
              ],
              detail: { sets: [{ home: 6, away: 3, closed: true }, { home: 6, away: 4, closed: true }] },
            },
          }),
        }),
      );
      expect(doc.header.subLines).toEqual([null, null]);
    });

    // The open set is whichever one the ENGINE'S mask says is open, and this
    // is the case that tells the two readings apart: an open set followed by
    // a closed one. Reading `closedMask[length - 1]` answers "everything is
    // closed" and drops the live score; scanning for the first `false` finds
    // it. No sport emits this ordering today — a set closes before the next
    // opens — which is exactly why the first draft's positional read looked
    // correct and why this test has to construct the mask rather than wait
    // for a fixture to produce one. What is being pinned is the contract the
    // function claims to follow, not a match anyone will play.
    it("the OPEN set is the one the engine's mask marks open, not the last column — an open set followed by a closed one still reports", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: "tennis",
          cfg: tennis.configSchema.parse({}),
          events: [],
          fixture: F({
            status: "in_play",
            summary: {
              headline: "0 — 0",
              perSide: [
                { entrantId: "home", line: "0" },
                { entrantId: "away", line: "0" },
              ],
              detail: {
                sets: [
                  { home: 6, away: 4, closed: false },
                  { home: 2, away: 1, closed: true },
                ],
              },
            },
          }),
        }),
      );
      expect(doc.header.subLines).toEqual(["(6)", "(4)"]);
    });

    // ...and the FIRST open one, not the last. Scanning from either end
    // satisfies the test above, so on its own that test is also passed by a
    // `findLastIndex`. Two open columns separate them. Same standing as the
    // case above: the mask is constructed, because the reading is what is
    // under test, not a scoreline anyone will play.
    it("with more than one column marked open it reports the FIRST — a scan from the other end is a different function", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: "tennis",
          cfg: tennis.configSchema.parse({}),
          events: [],
          fixture: F({
            status: "in_play",
            summary: {
              headline: "0 — 0",
              perSide: [
                { entrantId: "home", line: "0" },
                { entrantId: "away", line: "0" },
              ],
              detail: {
                sets: [
                  { home: 6, away: 4, closed: false },
                  { home: 2, away: 1, closed: false },
                ],
              },
            },
          }),
        }),
      );
      expect(doc.header.subLines).toEqual(["(6)", "(4)"]);
    });

    it("cricket (a DIFFERENT `detail` shape entirely — no `sets` array) is UNAFFECTED — subLines stays [null, null]", () => {
      const doc = buildMatchCentre(input({ sportKey: "cricket", fixture: F({ status: "scheduled" }) }));
      expect(doc.header.subLines).toEqual([null, null]);
    });

    it("football (a PERIODS breakdown, not a sets one) carries no subLine either — this fix is scoped to `kind: 'sets'`", () => {
      const doc = buildMatchCentre(
        input({
          sportKey: "football",
          cfg: FootballCfg.parse({}),
          events: [],
          fixture: F({
            status: "in_play",
            summary: {
              headline: "1 — 0",
              perSide: [
                { entrantId: "home", line: "1" },
                { entrantId: "away", line: "0" },
              ],
              detail: { periods: [{ phase: "1H", home: 1, away: 0 }] },
            },
          }),
        }),
      );
      expect(doc.header.subLines).toEqual([null, null]);
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
    // Fix round 1 — keyed by outcome.method, not the old regex-derived axis.
    expect(RESULT_KINDS).toContain("regulation");
    expect(RESULT_KINDS).toContain("dls");
    expect(RESULT_KINDS).toContain("innings");
    expect(RESULT_KINDS).toContain("super_over");
    expect(RESULT_KINDS).toContain("boundary_count");
    expect(RESULT_KINDS).toContain("tie");
    expect(RESULT_KINDS).toContain("no_result");
    expect(RESULT_KINDS).toContain("draw");
    expect(RESULT_KINDS).toContain("forfeit");
    expect(BALL_GLYPH_KINDS).toContain("wicket");
    expect(BALL_GLYPH_KINDS).toContain("runs");
  });
});

// ---------------------------------------------------------------------------
// Ball-by-ball commentary lines — the key family and its plural form
// ---------------------------------------------------------------------------
//
// These exist because a wicket's line shipped rendering the bare word
// "Wicket". `matchCentre.ball.<kind>` was BOTH the glyph-label family
// (`glyphs.tsx`: boundary/wicket/dot/extras/run) and the ball-line family,
// and they collided on `wicket`. Nothing caught it: the dictionary coverage
// test asserts the key EXISTS, and it did — as the label. The line family now
// lives under `matchCentre.ballLine.*`.
//
// The assertions below resolve the builder's own output through the REAL
// dictionary rather than stopping at the key, because the defect was
// invisible at the key: `matchCentre.ball.wicket` was a perfectly present
// key that said the wrong thing.
const BALL_LINE_SCRIPT: Script = {
  cfg: { ballsPerInnings: 12, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      batting: "home",
      bowlers: ["a7"],
      // 1 (the ONLY singular), 0 and 4 (both plural — 0 is the case a
      // `count > 1` rule gets wrong), a wide, a wicket, and a 2-bye.
      deliveries: [{ bat: 1 }, { bat: 0 }, { extra: "wide", runs: 1 }, { bat: 4 }, { out: "bowled" }, { extra: "bye", runs: 2 }],
      leaveOpen: true,
    },
  ],
};

describe("buildMatchCentre — ball-by-ball commentary lines", () => {
  const linesOf = (locale: string): MsgT[] => {
    const ledger = scriptLedger(BALL_LINE_SCRIPT);
    const doc = buildMatchCentre(input({ events: ledger.events, cfg: ledger.cfg, locale }));
    return (doc.cricket?.innings ?? []).flatMap((innings) => innings.overs.flatMap((over) => over.lines));
  };

  it("keys every line under `matchCentre.ballLine.`, never the glyph-label prefix", () => {
    const keys = linesOf("en").map((line) => line.key);
    expect(keys.length).toBe(6);
    for (const key of keys) expect(key.startsWith("matchCentre.ballLine.")).toBe(true);
    // The positive pair for the negative above: the collision was with THIS
    // exact key, so name it rather than only asserting a prefix.
    expect(keys).not.toContain("matchCentre.ball.wicket");
    expect(keys).toContain("matchCentre.ballLine.wicket");
  });

  it("inflects the run count: 1 takes the singular, 0 and 4 take the plural", () => {
    const keys = linesOf("en").map((line) => line.key);
    expect(keys[0], "1 run").toBe("matchCentre.ballLine.runs.one");
    expect(keys[1], "0 runs").toBe("matchCentre.ballLine.runs.other");
    expect(keys[3], "4 runs").toBe("matchCentre.ballLine.runs.other");
    expect(keys[5], "2 byes").toBe("matchCentre.ballLine.bye.other");
  });

  it("RESOLVES through the real dictionary to finished English, with no `(s)` and no bare key", () => {
    const dict = enPublic as Dict;
    const text = linesOf("en").map((line) => t(dict, line.key, line.params));
    // Not a key that failed to resolve, and not a parenthetical plural.
    for (const line of text) {
      expect(line, `unresolved key: ${line}`).not.toMatch(/^matchCentre\./);
      expect(line, `parenthetical plural: ${line}`).not.toContain("(s)");
    }
    expect(text[0]).toBe("0.1 · Player A7 · 1 run");
    expect(text[1]).toBe("0.2 · Player A7 · 0 runs");
    expect(text[3]).toBe("0.3 · Player A7 · 4 runs");
    // The defect itself: this used to be exactly "Wicket".
    expect(text[4]).toBe("0.4 · Player A7 · Wicket");
    expect(text[5]).toBe("0.5 · Player A7 · 2 byes");
  });

  it("picks the plural form in the DOC'S OWN locale, not always English's", () => {
    // French puts 0 in the SINGULAR category where English puts it in the
    // plural — so this pair differs between the two locales for the same
    // ball, which is what proves the builder reads `input.locale` rather
    // than hardcoding one rule. A locale whose answer matched English's
    // could not witness that.
    expect(linesOf("en")[1]!.key).toBe("matchCentre.ballLine.runs.other");
    expect(linesOf("fr")[1]!.key).toBe("matchCentre.ballLine.runs.one");
  });
});
