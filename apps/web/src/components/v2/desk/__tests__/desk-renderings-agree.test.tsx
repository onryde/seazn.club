import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { PhasePill, AttentionChip } from "@/components/v2/desk/phase-pill";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import { ProgressionPanel, type SeedProposal } from "@/components/v2/progression-panel";
import { StagesPanel } from "@/components/v2/stages-panel";
import { statusLine } from "@/lib/division-status-line";
import { leadingAttention,
  ATTENTION_SEVERITY, DIVISION_PHASES, DRAW_DOORS, hasPlayedFixture, resolveAttention, resolvePhase,
  type Attention, type DivisionPhase, type DrawDoor, type PhaseFixture, type PhaseInput, type PhaseStage,
} from "@/lib/division-phase";
import { competitionPhase, type CompetitionDesk, type DeskDivision } from "@/server/usecases/competition-desk";
import type { DeskInPlayFixture } from "@/server/usecases/competition-desk";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

/**
 * ENUMERATION 2 (fix round I): every RENDERING x every reachable
 * phase/attention pair.
 *
 * Instances 9 through 12 of this wave's signature defect are one class —
 * reachability asserted from a TYPE or a WORD rather than from the SCREEN —
 * and every one of them was a rendering that disagreed with another
 * rendering of the SAME division. Five surfaces state a division's condition:
 *
 *   1. the competition masthead pill   (competitionPhase + PhasePill)
 *   2. the ledger row pill             (PhasePill)
 *   3. the row's status line           (statusLine)
 *   4. the Needs-you item              (needsYouItems)
 *   5. the division page's start-locks tip (StagesPanel)
 *
 * They were fixed one at a time, in rounds F, G and H, each time by finding
 * the ONE surface that had not learned the rule. This file asks all five at
 * once, for every pair that can actually occur.
 *
 * WHY IT FAILS WHEN A ROW IS DROPPED: the expectation is anchored OUTSIDE the
 * table. `REQUIRED_PAIRS` is the full cross product of `DIVISION_PHASES` x
 * (`ATTENTION_SEVERITY`'s keys + "none") minus `UNREACHABLE`, each exclusion
 * carrying the rule that makes it impossible. The sweep then asserts the
 * shapes cover exactly that set. Delete a shape and its pair goes uncovered;
 * add a phase or an attention kind and the cross product grows and stays
 * uncovered until someone either builds it or justifies it. Neither a value
 * change nor a deletion can pass quietly.
 */

const ATTENTION_KINDS = Object.keys(ATTENTION_SEVERITY) as Attention["kind"][];
const LEADING = [...ATTENTION_KINDS, "none"] as const;
type Leading = (typeof LEADING)[number];

/** Pairs the model makes impossible, each with the rule that forbids it. */
const UNREACHABLE: Record<string, string> = {
  // Rule 2 refuses `finished` while any open stage owes work, and both of
  // these rows ARE an open stage owing work.
  "finished/needs_draw": "an open stage owing its draw blocks rule 2",
  "finished/needs_fixtures": "an open stage with no fixtures blocks rule 2",
  // Rule 2 (J2) also refuses `finished` while any fixture is still LIVE
  // (`scheduled` or `in_play`), and all three of these rows require one.
  // An `in_play` fixture IS rule 3's match day, unconditionally and before
  // rules 4 and 5 are reached — so the one row that requires one can only
  // ever sit beside `match_day`.
  "finished/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  "setting_up/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  "scheduled/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  // `not_recording` (round J) needs an in_play fixture for exactly the same
  // reason its complement does — the two differ only on whether a scorer is
  // assigned, never on the fixture status either one requires.
  "finished/not_recording": "not_recording needs an in_play fixture, which is match day",
  "setting_up/not_recording": "not_recording needs an in_play fixture, which is match day",
  "scheduled/not_recording": "not_recording needs an in_play fixture, which is match day",
  "finished/unscheduled": "unscheduled needs a `scheduled` fixture, which is live",
  "finished/result_missing": "result_missing needs a `scheduled` fixture, which is live",
  // `needs_draw` is raised for the FIRST open stage (a later one needs
  // `noLive`, and its own generated TBD fixtures are `scheduled`, i.e. live),
  // and a first open stage owing work is exactly rule 4's `setting_up` —
  // unless rule 3 gets there first. So the draw row can only ever sit beside
  // `setting_up` or `match_day`.
  "scheduled/needs_draw": "rule 4 fires whenever the first open stage owes its draw",
  // `result_missing` needs a fixture that carries a DATE, and any dated
  // fixture is answered by rule 3 (today) or rule 5 (`hasScheduledFixture`)
  // long before rule 6's `setting_up` fallback is reached. The only way to
  // pair the two would be a stage owing work as well — and that raises a RED
  // row, which leads instead.
  "setting_up/result_missing": "a dated fixture is answered by rule 3 or 5, never rule 6's setting_up",
};

type Shape = {
  /** What an organiser did to get here — the state, not the assertion. */
  why: string;
  stages: PhaseStage[];
  fixtures: PhaseFixture[];
  divisionStatus?: PhaseInput["divisionStatus"];
  awaitingRegistrations?: number;
  entrants?: number;
};

const NOW = "2026-09-05T09:42:00Z"; // Sat 10:42 Europe/London
const TZ = "Europe/London";
const TODAY = "2026-09-05T14:00:00Z";
const PAST = "2026-09-05T06:00:00Z"; // today, and its window has closed
const FUTURE = "2026-09-19T09:00:00Z";

const st = (o: Partial<PhaseStage> = {}): PhaseStage => ({
  id: "s1", name: "League", seq: 1, status: "active", hasFixtures: true,
  timing: null, sourceReady: false, proposal: "none", ...o,
});
/** A stage whose TBD bracket is generated and whose sources are complete —
 *  the ONLY state in which the panel's draw door both renders and works. */
const drawableStage = (o: Partial<PhaseStage> = {}) =>
  st({ id: "fin", name: "Finals", seq: 2, status: "active", hasFixtures: true,
       timing: "setup", sourceReady: true, ...o });
const fxt = (o: Partial<PhaseFixture> = {}): PhaseFixture => ({
  id: "f1", status: "decided", scheduledAt: FUTURE, startedAt: null, eventCount: 0, matchMinutes: 90,
  hasScorer: true, stageId: "s1", awaitsSeedDraw: false, ...o,
});
const awaitsDraw = (o: Partial<PhaseFixture> = {}) =>
  fxt({ id: "tbd1", stageId: "fin", awaitsSeedDraw: true, status: "scheduled", scheduledAt: null, ...o });

const SHAPES: Shape[] = [
  {
    why: "setting_up/needs_draw — league complete, the finals bracket generated and its draw owed",
    stages: [st({ status: "complete" }), drawableStage()],
    fixtures: [fxt({ id: "a" }), awaitsDraw()],
  },
  {
    why: "setting_up/needs_fixtures — league complete, the next stage never generated",
    stages: [st({ status: "complete" }), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false })],
    fixtures: [fxt({ id: "a" })],
  },
  {
    why: "setting_up/unscheduled — nothing dated yet, nothing played",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "setting_up/registrations_waiting — a brand-new division still taking entries",
    stages: [], fixtures: [], divisionStatus: "setup", awaitingRegistrations: 3, entrants: 4,
  },
  {
    why: "setting_up/none — a division created and not yet touched",
    stages: [], fixtures: [], divisionStatus: "setup", entrants: 4,
  },
  {
    why: "scheduled/needs_fixtures — INSTANCE TWELVE's shape: the league is played out but never completed, and the finals bracket was never generated",
    stages: [st(), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false, timing: "setup", sourceReady: false })],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b" })],
  },
  {
    why: "scheduled/unscheduled — a mid-season league with the next round undated",
    stages: [st()],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "scheduled/result_missing — an overdue kick-off with the rest of the season still dated",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE }),
               fxt({ id: "b", status: "scheduled", scheduledAt: "2026-09-01T06:00:00Z" })],
  },
  {
    why: "scheduled/registrations_waiting — a running division with late entries to approve",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
    awaitingRegistrations: 2,
  },
  {
    why: "scheduled/none — a settled, dated season",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
  },
  {
    why: "match_day/needs_draw — today's last group match is dated and the finals draw is owed",
    stages: [st({ status: "complete" }), drawableStage()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: TODAY }), awaitsDraw()],
  },
  {
    why: "match_day/needs_fixtures — today's match is dated and the next stage is empty",
    stages: [st({ status: "complete" }), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false })],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: TODAY })],
  },
  {
    why: "match_day/no_scorer — kicked off, nothing being recorded",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: false, scheduledAt: PAST })],
  },
  {
    // The complement of the row above: a scorer IS assigned, and nothing has
    // arrived from them. `PAST` is 3h42m before NOW, comfortably past the
    // grace, so this shape survives a change to the constant in either
    // direction rather than sitting on its boundary.
    why: "match_day/not_recording — kicked off with a scorer assigned, still nothing recorded",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true, eventCount: 0, scheduledAt: PAST })],
  },
  {
    why: "match_day/unscheduled — playing today, later rounds undated",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true }),
               fxt({ id: "b", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "match_day/result_missing — this morning's match has no result and this evening's is still to come",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: PAST })],
  },
  {
    why: "match_day/registrations_waiting — playing today with entries pending",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
    awaitingRegistrations: 1,
  },
  {
    why: "match_day/none — playing today, everything in hand",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
  },
  {
    why: "finished/registrations_waiting — the season is over and an entry was never dealt with",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed", awaitingRegistrations: 1,
  },
  {
    why: "finished/none — a completed season",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed",
  },
];

const PLAYED = new Set(["decided", "finalized"]);

function resolve(shape: Shape) {
  const input: PhaseInput = {
    divisionStatus: shape.divisionStatus ?? "active",
    stages: shape.stages, fixtures: shape.fixtures, now: NOW, tz: TZ,
    awaitingRegistrations: shape.awaitingRegistrations ?? 0,
  };
  const phase = resolvePhase(input);
  const attention = resolveAttention(input);
  const leading: Leading = attention[0]?.kind ?? "none";
  const played = shape.fixtures.filter((f) => PLAYED.has(f.status)).length;
  const needsDraw = attention.find((a) => a.kind === "needs_draw");
  const desk: DeskDivision = {
    phase, attention,
    played, total: shape.fixtures.length,
    unscheduled: shape.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length,
    in_play: shape.fixtures.filter((f) => f.status === "in_play").length,
    entrants: shape.entrants ?? 6,
    next: null,
    needs_draw_stage: needsDraw && needsDraw.kind === "needs_draw" ? { name: needsDraw.stageName } : null,
    fixture_names: Object.fromEntries(shape.fixtures.map((f, i) => [f.id, { home: "Alpha", away: "Bravo", fixture_no: i + 1 }])),
    display_tz: TZ,
  };
  return { input, phase, attention, leading, desk, played };
}

describe("enumeration 2: the five renderings agree on every reachable phase/attention pair", () => {
  const resolved = SHAPES.map((s) => ({ shape: s, ...resolve(s) }));

  it("the table covers exactly the reachable cross product — a dropped row leaves a pair uncovered", () => {
    const required = DIVISION_PHASES.flatMap((p) => LEADING.map((l) => `${p}/${l}`))
      .filter((pair) => !(pair in UNREACHABLE))
      .sort();
    const covered = [...new Set(resolved.map((r) => `${r.phase}/${r.leading}`))].sort();
    expect(covered).toEqual(required);
    // And every declared exclusion still names a pair in the domain, so a
    // renamed phase or kind cannot leave a stale excuse behind.
    for (const pair of Object.keys(UNREACHABLE)) {
      const [p, l] = pair.split("/") as [DivisionPhase, Leading];
      expect(DIVISION_PHASES as readonly string[]).toContain(p);
      expect(LEADING as readonly string[]).toContain(l);
    }
  });

  it("each shape reaches the pair its own `why` claims — a shape cannot drift off its case", () => {
    for (const r of resolved) {
      // The `why` string LEADS with the pair it claims, so a shape that
      // drifts onto another case is caught by its own label rather than
      // quietly covering a pair it was not written for.
      expect(`${r.phase}/${r.leading}`, r.shape.why).toBe(r.shape.why.split(" ")[0]);
    }
  });

// Review finding m8: `competition-desk.ts` documents (and
// `competition-desk.test.ts` pins) `in_play === in_play_fixtures.length`
// ALWAYS. These fixtures used to pair a non-zero `in_play` with an empty
// `in_play_fixtures`, which no consumer in these two files reads today but
// which is an impossible desk — the next consumer that trusts the documented
// invariant would be exercised against a shape the producer cannot emit. The
// list is now derived FROM the count, so the two can never drift apart here.
const inPlayFixtures = (n: number, divisionId = "d1"): DeskInPlayFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ip${i + 1}`,
    division_id: divisionId,
    division_name: "Premier Division",
    home: "Alpha",
    away: "Bravo",
    fixture_no: i + 1,
    event_count: 0,
    headline: null,
    started_at: null,
  }));

  describe.each(resolved.map((r) => [r.shape.why, r] as const))("%s", (_why, r) => {
    const red = r.attention.find((a) => ATTENTION_SEVERITY[a.kind] === "red");

    it("1+2: the masthead and the row pill never say a division is setting up when it has played", () => {
      const rowPill = renderToStaticMarkup(
        <PhasePill dict={en} phase={r.phase} inPlay={r.desk.in_play} attention={r.attention} />,
      );
      // Task 6: this file's cases don't exercise the band itself — but the
      // fixture list is DERIVED from the count (see `inPlayFixtures`), never
      // an empty array beside a non-zero one (review m8).
      const desk: CompetitionDesk = {
        in_play: r.desk.in_play, in_play_fixtures: inPlayFixtures(r.desk.in_play), up_next: null,
        divisions: new Map([["d1", r.desk]]), now: NOW,
      };
      const cp = competitionPhase(desk);
      // Review 7, Minor 9: this rendered the masthead with `attention={[]}`,
      // so the file written to make five renderings AGREE did not exercise the
      // masthead's own attention wiring at all and could not see a regression
      // in it. It mirrors the page now — the phase pill, plus the separate
      // attention chip beside it (page.tsx).
      const leading = leadingAttention([r.desk]);
      const masthead = renderToStaticMarkup(
        <>
          <PhasePill dict={en} phase={cp.kind === "in_play" ? "in_play" : cp.kind === "next" ? "next" : cp.kind}
            inPlay={cp.kind === "in_play" ? cp.n : 0} when="Sat 12 Sep" />
          <AttentionChip dict={en} attention={leading} />
        </>,
      );
      if (r.played > 0) {
        expect(rowPill).not.toContain(en["desk.phase.setting_up"]);
        expect(masthead).not.toContain(en["desk.phase.setting_up"]);
      }
      // A red attention outranks the phase on the row pill — the model rule,
      // asserted here for EVERY pair rather than for the one kind a fix
      // happened to be about.
      // And the masthead names the SAME red kind — the F4 rule, swept over
      // every reachable pair rather than proven on the one shape a test
      // happened to build. It keeps the phase BESIDE it (review 7, Minor 7):
      // a red attention must never delete the live count.
      if (red) {
        expect(rowPill).toContain(`data-pill="${red.kind}"`);
        expect(masthead).toContain(`data-attention-chip="${red.kind}"`);
        if (cp.kind === "in_play") expect(masthead).toContain(en["desk.phase.in_play"].replace("{n}", String(cp.n)));
      } else {
        expect(rowPill).toContain(`data-pill="${r.phase}"`);
        expect(masthead).not.toContain("data-attention-chip");
      }
    });

    it("3: the status line agrees with the pill — it never claims setting-up progress a played row contradicts", () => {
      const line = statusLine(en, {
        phase: r.phase, played: r.played, total: r.desk.total, unscheduled: r.desk.unscheduled,
        inPlay: r.desk.in_play, entrants: r.desk.entrants, next: null,
        needsDrawStageName: r.desk.needs_draw_stage?.name ?? null,
        locale: "en", displayTz: TZ, now: NOW,
      });
      if (r.played > 0 || r.desk.total > 0) expect(line).not.toContain("entrants");
      // M1 minor: whenever a draw is owed and nothing is being played, the
      // sentence NAMES the stage — it used to do that only under the
      // `setting_up` word.
      if (r.desk.needs_draw_stage && r.desk.in_play === 0) {
        expect(line).toContain(`${r.desk.needs_draw_stage.name} not drawn`);
      }
    });

    it("4: a red attention always has a Needs-you row of the same kind, with an action", () => {
      const items = needsYouItems(
        en,
        { in_play: r.desk.in_play, in_play_fixtures: inPlayFixtures(r.desk.in_play), up_next: null, divisions: new Map([["d1", r.desk]]), now: NOW },
        [{ id: "d1", name: "Premier", slug: "premier" }], "org", "comp", "en",
      );
      // registrations_waiting is aggregated to ONE competition-level row, so
      // it is keyed differently by design; every other kind is per division.
      for (const a of r.attention) {
        const item = items.find((i) => i.kind === a.kind);
        expect(item, `${a.kind} has no Needs-you row`).toBeDefined();
        expect(item?.action.label.length, `${a.kind} action label is empty`).toBeGreaterThan(0);
        expect(item?.action.href.startsWith("/o/org/c/comp"), `${a.kind} href`).toBe(true);
      }
      if (red) expect(items[0]?.kind).toBe(red.kind);
    });

    it("5: the start-locks tip shows only while nothing has been played", () => {
      const html = renderToStaticMarkup(
        <StagesPanel divisionId="d1" competitionId="c1" orgSlug="org" compSlug="comp" divSlug="div"
          stages={r.shape.stages.map((s) => ({ id: s.id, seq: s.seq, kind: "league", name: s.name, config: {}, progression: null, status: s.status }))}
          fixtures={r.shape.fixtures.map((f, i) => ({
            id: f.id, stage_id: f.stageId, pool_id: null, round_no: 1, seq_in_round: i + 1, fixture_no: i + 1,
            // An awaiting-draw fixture is an EMPTY, LABELLED pair of seats —
            // both halves, or the row disagrees with the `awaitsSeedDraw` it
            // was built from and stops being the same division in two
            // renderings, which is the one thing this sweep exists to check.
            home_entrant_id: f.awaitsSeedDraw ? null : "e1", away_entrant_id: f.awaitsSeedDraw ? null : "e2",
            home_slot_label: f.awaitsSeedDraw ? { key: "slot.rank", params: { rank: 1 }, seed: 1 } : null,
            away_slot_label: f.awaitsSeedDraw ? { key: "slot.rank", params: { rank: 2 }, seed: 2 } : null,
            scheduled_at: f.scheduledAt, venue: null, court_label: null, court_id: null, court_name: null,
            status: f.status, outcome: null,
          }))}
          entrantNames={{ e1: "Alpha", e2: "Bravo" }} canEdit tz={TZ} orgTz={TZ} canExport={false} phase={r.phase} viewerPlan="community" />,
      );
      const shown = html.includes('data-tip="division.start-locks"');
      // `stages.length > 0` is the panel's own earlier gate — with no stage
      // graph at all it renders "no stages yet" and nothing else, which is
      // why it is part of the expectation rather than a surprise.
      expect(shown, `phase ${r.phase}, played ${r.played}, stages ${r.shape.stages.length}`).toBe(
        r.phase === "setting_up" && !hasPlayedFixture(r.shape.fixtures) && r.shape.stages.length > 0,
      );
      // The invariant the tip exists to respect, stated independently of its
      // own gate: it must never appear beside a played fixture.
      if (r.played > 0) expect(shown).toBe(false);
    });
  });
});

/**
 * M1 (fix round I): the `needs_draw` row's action must name a button the
 * PANEL IS ACTUALLY SHOWING — the whole reason the label renders the panel's
 * own dictionary key instead of a copy of its words.
 *
 * Not a tautology: the expected string is not read from `DRAW_DOOR_KEY` but
 * extracted from a REAL `ProgressionPanel` rendered in the matching state, so
 * it dies if either side moves — the map, the panel's copy, or the panel's
 * branch structure. Mutating `DRAW_DOOR_KEY.confirm` to `computeCta` left the
 * whole 256-test desk suite green before this existed.
 */
const PANEL_QUALIFIERS = {
  qualifiers: [
    { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
    { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e2", destinationSlot: "f1:away" },
  ],
  ties: [],
  standingsHash: "h1",
};
const PANEL_PROPOSAL: Record<DrawDoor, SeedProposal | null> = {
  compute: null,
  confirm: { id: "p1", stageId: "ko1", status: "draft", computed: PANEL_QUALIFIERS },
  recompute: { id: "p1", stageId: "ko1", status: "stale", computed: PANEL_QUALIFIERS },
};

describe("the needs_draw action names a button the seed-proposal panel is showing", () => {
  it.each(DRAW_DOORS)("%s", (door) => {
    const desk: DeskDivision = {
      phase: "setting_up", attention: [{ kind: "needs_draw", stageName: "Finals", door }],
      played: 6, total: 6, unscheduled: 0, in_play: 0, entrants: 4, next: null,
      needs_draw_stage: { name: "Finals" }, fixture_names: {}, display_tz: TZ,
    };
    const items = needsYouItems(
      en,
      { in_play: 0, in_play_fixtures: [], up_next: null, divisions: new Map([["d1", desk]]), now: NOW },
      [{ id: "d1", name: "Premier", slug: "premier" }], "org", "comp", "en",
    );
    const label = items.find((i) => i.kind === "needs_draw")?.action.label;
    expect(label, `no needs_draw row for the ${door} door`).toBeTruthy();

    const html = renderToStaticMarkup(
      <ProgressionPanel stageId="ko1" stageName="Finals" proposal={PANEL_PROPOSAL[door]} sourceReady
        fixtures={[{ id: "f1", home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
                     away_slot_label: { key: "slot.winner_group", params: { g: "B" } } }]}
        entrantNames={{ e1: "Alice", e2: "Bob" }} stageNames={{ grp: "Groups" }} departedEntrantIds={[]} locale="en" canEdit />,
    );
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1]!.replace(/<[^>]*>/g, "").trim())
      .filter(Boolean);
    expect(buttons.length, `the ${door} panel state renders no button at all`).toBeGreaterThan(0);
    expect(buttons, `the desk offers "${label}" but the panel's ${door} state shows ${JSON.stringify(buttons)}`)
      .toContain(label);
  });
});
