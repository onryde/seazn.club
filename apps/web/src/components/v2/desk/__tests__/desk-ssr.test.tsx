import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { plural } from "@/lib/i18n";
import { PhasePill, RED_PILL_KEY } from "@/components/v2/desk/phase-pill";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { DivisionLedger } from "@/components/v2/desk/division-ledger";
import { resolvePhase, resolveAttention, ATTENTION_SEVERITY, type Attention, type PhaseInput } from "@/lib/division-phase";
import { statusLine } from "@/lib/division-status-line";
import { competitionPhase, type CompetitionDesk, type DeskDivision } from "@/server/usecases/competition-desk";
import type { DeskInPlayFixture } from "@/server/usecases/competition-desk";

// `division_id` is test-scaffolding only — production's own DeskDivision has
// no such field (competition-desk.ts's minor fix: it was dead there, since
// the `Map<string, DeskDivision>` is already keyed by the same id; deleted).
// This local shape keeps the convenient "one call builds both the row and
// its map key" pattern below without reintroducing it into the real type.
type TestDivision = DeskDivision & { division_id: string };
const div = (o: Partial<TestDivision> = {}): TestDivision => ({
  division_id: "d1", phase: "scheduled", attention: [], played: 10, total: 15, unscheduled: 0, in_play: 0,
  entrants: 6, next: null, needs_draw_stage: null,
  fixture_names: {}, display_tz: "Europe/London", ...o,
});
// Task 6: none of this file's cases exercise `in_play_fixtures`/`up_next`
// (they predate both fields) — every desk() / deskOf() fixture below gets
// the honest empty/null default, same as a competition with nothing live.
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

const desk = (d: TestDivision, inPlay = 0, now = "2026-09-05T09:00:00Z"): CompetitionDesk => {
  const { division_id, ...rest } = d;
  return {
    in_play: inPlay, in_play_fixtures: inPlayFixtures(inPlay, division_id), up_next: null,
    divisions: new Map([[division_id, rest]]), now,
  };
};
/** competitionPhase's own ladder needs more than one division to prove the
 *  "earliest across divisions" and "match_day beats a dated fixture
 *  elsewhere" steps — `desk()` above only ever seeds one. */
const deskOf = (divisions: TestDivision[], inPlay = 0, now = "2026-09-05T09:00:00Z"): CompetitionDesk => ({
  in_play: inPlay,
  in_play_fixtures: inPlayFixtures(inPlay, divisions[0]?.division_id ?? "d1"),
  up_next: null,
  divisions: new Map(divisions.map(({ division_id, ...rest }) => [division_id, rest])), now,
});
const names = [{ id: "d1", name: "Premier Division", slug: "premier-division" }];

describe("PhasePill", () => {
  it("shows the phase when nothing is red", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" />);
    expect(html).toContain('data-phase="scheduled"');
    expect(html).toContain("Scheduled");
  });
  it("red attention beats the phase", () => {
    const html = renderToStaticMarkup(
      <PhasePill dict={en} phase="setting_up" attention={[{ kind: "needs_draw", door: "compute" as const, stageName: "Finals" }]} />,
    );
    expect(html).toContain('data-phase="setting_up"');
    expect(html).toContain('data-pill="needs_draw"');
    expect(html).toContain("Needs draw");
    expect(html).not.toContain("Setting up");
  });
  // K1 (fix round G): the label used to come from a TERNARY —
  // `red.kind === "needs_draw" ? "desk.pill.needs_draw" : "desk.pill.no_scorer"`
  // — so any red kind that was not `needs_draw` rendered "No scorer". This
  // pins the third one against exactly that mutant.
  it("K1: a needs_fixtures attention renders its OWN pill word, never 'No scorer'", () => {
    const html = renderToStaticMarkup(
      <PhasePill dict={en} phase="scheduled" attention={[{ kind: "needs_fixtures", stageName: "Finals" }]} />,
    );
    expect(html).toContain('data-pill="needs_fixtures"');
    expect(html).toContain("Needs fixtures");
    expect(html).not.toContain("No scorer");
    expect(html).not.toContain("Scheduled");
  });
  it("amber attention does not beat the phase", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" attention={[{ kind: "unscheduled", count: 3 }]} />);
    expect(html).toContain("Scheduled");
    expect(html).not.toContain('data-pill="unscheduled"');
  });
  /**
   * Fix round I, minor: `phase-pill.tsx`'s severity FILTER and its
   * `RED_PILL_KEY` map were two guards covering for each other — the review
   * mutated each alone and the file stayed green. The three tests below
   * isolate them; each one dies under exactly one of the two mutations.
   */
  it("the severity filter, alone: an UNSORTED list still finds the RED member", () => {
    // `resolveAttention` sorts red first, so a sorted list cannot tell the
    // filter apart from `attention[0]`. This prop is handed in unsorted on
    // purpose: without the filter the amber row wins, maps to `null`, and
    // the pill falls back to the phase word.
    const html = renderToStaticMarkup(
      <PhasePill dict={en} phase="scheduled"
        attention={[{ kind: "unscheduled", count: 3 }, { kind: "no_scorer", count: 1, fixtureIds: ["f"], minutesSinceKickoff: 4 }]} />,
    );
    expect(html).toContain('data-pill="no_scorer"');
    expect(html).toContain("No scorer");
    expect(html).not.toContain("Scheduled");
  });
  it.each([
    ["needs_draw", "Needs draw", { kind: "needs_draw", stageName: "Finals", door: "compute" }],
    ["needs_fixtures", "Needs fixtures", { kind: "needs_fixtures", stageName: "Finals" }],
    ["no_scorer", "No scorer", { kind: "no_scorer", count: 1, fixtureIds: ["f"], minutesSinceKickoff: 4 }],
    ["needs_decision", "Needs a decision", { kind: "needs_decision", count: 1, fixtureIds: ["f"] }],
  ] as const)("RED_PILL_KEY, alone: %s prints its own word", (kind, word, attention) => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="scheduled" attention={[attention as Attention]} />);
    expect(html).toContain(`data-pill="${kind}"`);
    expect(html).toContain(word);
  });
  it("RED_PILL_KEY's nulls, alone: they agree with ATTENTION_SEVERITY, the ONE authority for which kinds are red", () => {
    // Derived from the severity table rather than typed out, so this moves
    // when the source of truth moves. It is the only test that dies when a
    // `null` entry becomes a key while the filter is left intact: the filter
    // would never reach that kind, but the two tables would now disagree.
    for (const kind of Object.keys(ATTENTION_SEVERITY) as Attention["kind"][]) {
      const red = ATTENTION_SEVERITY[kind] === "red";
      expect(RED_PILL_KEY[kind] === null, `${kind}: severity ${ATTENTION_SEVERITY[kind]}`).toBe(!red);
    }
  });
  it("in_play carries the count", () => {
    expect(renderToStaticMarkup(<PhasePill dict={en} phase="in_play" inPlay={2} />)).toContain("2 in play");
  });
  it("competitionPhase minor fix: 'next' carries the pre-formatted date, not a phase word", () => {
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="next" when="Sat 12 Sep" />);
    expect(html).toContain('data-phase="next"');
    expect(html).toContain("Next Sat 12 Sep");
  });
});

// competitionPhase minor fix (final review): the old implementation ranked
// the four DivisionPhase words and printed whichever ranked lowest, so the
// spec's own third ladder step — "the earliest next fixture date" — could
// never render at all, and "Setting up" was reachable even with real dated
// fixtures elsewhere (live repro: a competition 43 matches deep read
// "Setting up" above a correctly-drawn "Needs draw" division). These pin
// the ladder's actual step order, not just that SOME string comes out.
describe("competitionPhase", () => {
  it("amendment 3 (binding): an empty competition is setting_up, never finished", () => {
    expect(competitionPhase(deskOf([]))).toEqual({ kind: "setting_up" });
  });
  it("in_play outranks everything, even a match-day division elsewhere", () => {
    const live = div({ phase: "match_day" });
    expect(competitionPhase(deskOf([live], 1))).toEqual({ kind: "in_play", n: 1 });
  });
  it("match_day outranks a dated next fixture in a different division", () => {
    const onMatchDay = div({ division_id: "d1", phase: "match_day" });
    const dated = div({
      division_id: "d2", phase: "scheduled",
      next: { home: "A", away: "B", scheduled_at: "2026-09-06T09:00:00Z", in_play: false },
    });
    expect(competitionPhase(deskOf([onMatchDay, dated]))).toEqual({ kind: "match_day" });
  });
  it("else: the EARLIEST next fixture date across divisions, not a ranked phase word", () => {
    const later = div({
      division_id: "d1", phase: "scheduled",
      next: { home: "A", away: "B", scheduled_at: "2026-09-20T09:00:00Z", in_play: false },
    });
    const earlier = div({
      division_id: "d2", phase: "scheduled", display_tz: "America/New_York",
      next: { home: "C", away: "D", scheduled_at: "2026-09-12T09:00:00Z", in_play: false },
    });
    // Division map insertion order deliberately does NOT match date order —
    // a naive "first division's next" implementation would return the wrong
    // date here.
    // The zone travels WITH the date: the masthead names ONE division's
    // fixture, and that division may sit in a different zone from the org.
    // Formatting the winner in the org zone printed "Next Mon 7 Sep" above a
    // row reading "Next Sun 6 Sep 19:00" — same fixture, two days, one screen
    // (found by driving a London org with a New York division at 23:00Z).
    expect(competitionPhase(deskOf([later, earlier]))).toEqual({
      kind: "next", at: "2026-09-12T09:00:00Z", tz: "America/New_York",
    });
  });
  it("a past-kicked-off or TBD-time next fixture is not a ladder answer (mirrors the F5 guard)", () => {
    const past = div({
      division_id: "d1", phase: "scheduled",
      next: { home: "A", away: "B", scheduled_at: "2026-09-01T09:00:00Z", in_play: false },
    });
    const undated = div({
      division_id: "d2", phase: "setting_up",
      next: { home: "C", away: "D", scheduled_at: null, in_play: false },
    });
    const phase = competitionPhase(deskOf([past, undated], 0, "2026-09-05T09:00:00Z"));
    // What this test is FOR: neither a past kick-off nor a null time may be
    // picked as the ladder's date answer.
    expect(phase.kind).not.toBe("next");
    // And the fallback still has to agree with the rows underneath it: d1 is
    // a `scheduled` division, so the masthead cannot claim the competition is
    // being set up. (Found by driving round C: the masthead read "Setting up"
    // directly above a row reading "Scheduled".)
    expect(phase).toEqual({ kind: "scheduled" });
  });
  it("all finished, with no live division left to date, reads finished", () => {
    const a = div({ division_id: "d1", phase: "finished", next: null });
    const b = div({ division_id: "d2", phase: "finished", next: null });
    expect(competitionPhase(deskOf([a, b]))).toEqual({ kind: "finished" });
  });
  // REVERSED by K2 (fix round G, Important — instance TEN). This test used to
  // expect `setting_up` here and its title called that "chosen": a `finished`
  // division and a `setting_up` one, nothing dated, was declared "nothing
  // informative yet". It is the wave's signature defect frozen as an expected
  // value — the masthead says the competition has not begun, directly above a
  // row that says a division has finished. Driven live at three widths on the
  // sibling shape (a `setting_up` row reading "6 of 6 played · Finals not
  // drawn" under a "Setting up" masthead) before the fallback was fixed.
  it("K2: a finished row beside a setting_up one is NOT 'setting up' — the masthead never contradicts the rows", () => {
    const settingUp = div({ division_id: "d1", phase: "setting_up", next: null });
    const finished = div({ division_id: "d2", phase: "finished", next: null });
    expect(competitionPhase(deskOf([settingUp, finished]))).toEqual({ kind: "scheduled" });
  });
  it("K2: a setting_up row that has already PLAYED something is not 'setting up' either", () => {
    // The exact live shape: one division, rule-4 `setting_up` (its finals are
    // undrawn), 6 of 6 league fixtures played, nothing dated. The phase WORD
    // agrees with the fallback; the row's own numbers do not.
    const played = div({ division_id: "d1", phase: "setting_up", played: 6, total: 6, next: null });
    expect(competitionPhase(deskOf([played]))).toEqual({ kind: "scheduled" });
  });
  it("K2: and 'setting up' is still reachable — every row setting_up with nothing played", () => {
    // Without this the fix could have been "never setting_up", and the pill
    // amendment 3 exists for (a fresh competition) would have been lost.
    const a = div({ division_id: "d1", phase: "setting_up", played: 0, total: 0, next: null });
    const b = div({ division_id: "d2", phase: "setting_up", played: 0, total: 6, next: null });
    expect(competitionPhase(deskOf([a, b]))).toEqual({ kind: "setting_up" });
  });
});

describe("NeedsYou", () => {
  it("renders nothing at all when there is nothing to do", () => {
    expect(NeedsYou({ dict: en, items: [] })).toBeNull();
  });
  it("builds one item per attention with a division-scoped href, severity first", () => {
    const d = div({
      phase: "match_day", in_play: 1,
      attention: [
        { kind: "unscheduled", count: 3 },
        { kind: "no_scorer", count: 1, fixtureIds: ["f9"], minutesSinceKickoff: 12 },
      ],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d, 1), names, "org", "comp", "en");
    expect(items.map((i) => i.kind)).toEqual(["no_scorer", "unscheduled"]);
    expect(items[0].title).toBe("Premier Division · Riverside FC v Summit CC has no scorer");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division/f/9");
    expect(items[1].action.href).toBe("/o/org/c/comp/d/premier-division/schedule");
    const html = renderToStaticMarkup(<NeedsYou dict={en} items={items} />);
    expect(html).toContain('data-attention="no_scorer"');
    expect(html).toContain('data-severity="red"');
    // M2 (fix round I, Important): this row used to read "Assign scorer",
    // an action nobody can take — org-member scorers and assignment invites
    // were retired (#707). The landing fixture
    // console had 0 such controls (counted live, 11:39Z on 2026-09-03).
    // The row now asks for the thing that IS on that screen: the pad.
    expect(html).toContain("Open scoring");
    expect(html).not.toContain("Assign scorer");
  });
  it("loop R M7(e): every Needs-you action is a 44px tap target below lg (768 and 834 are touch widths), compact only at lg", () => {
    // The desktop row (md and up) carried `py-1.5 text-xs` — 28px at 768, a touch width. Each row's two actions (the
    // phone stack and the md row) are read; every item, red and amber.
    const d = div({
      phase: "match_day", in_play: 1,
      attention: [
        { kind: "unscheduled", count: 3 },
        { kind: "no_scorer", count: 1, fixtureIds: ["f9"], minutesSinceKickoff: 12 },
      ],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d, 1), names, "org", "comp", "en");
    const html = renderToStaticMarkup(<NeedsYou dict={en} items={items} />);
    const rowLinks = [...html.matchAll(/<div class="hidden items-center[^"]*md:flex">[\s\S]*?<a [^>]*class="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/));
    expect(rowLinks.length, "one md row per item").toBe(items.length);
    expect(rowLinks.length).toBeGreaterThan(0);
    for (const cls of rowLinks) {
      expect(cls, "44px below lg").toContain("min-h-11");
      expect(cls, "compact from lg (a mouse width)").toContain("lg:min-h-0");
    }
  });
  // F3 fix (final review, Important): used to be one row PER FIXTURE — a
  // division with 6 overdue fixtures produced 6 identical rows. Now ONE row,
  // stating the count, deep-linking to the fixtures tab (which shows all of
  // them) rather than any single fixture.
  it("F3: no_scorer on several fixtures collapses to ONE row naming the count, linking to the fixtures tab", () => {
    const d = div({
      phase: "match_day", in_play: 2,
      attention: [{ kind: "no_scorer", count: 2, fixtureIds: ["f9", "f10"], minutesSinceKickoff: 42 }],
      fixture_names: {
        f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 },
        f10: { home: "Valley CC", away: "Lakeside FC", fixture_no: 10 },
      },
    });
    const items = needsYouItems(en, desk(d, 2), names, "org", "comp", "en");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Premier Division · 2 fixtures have no scorer");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division?tab=fixtures");
    expect(items[0].sub).toBe("Kicked off 42 min ago. Nothing is being recorded.");
  });
  // division-phase.ts:134 minor fix: no scheduledAt anywhere in the group ⇒
  // the sub-line drops the elapsed-time clause instead of lying "0 min ago".
  it("no_scorer sub-line omits the elapsed-time clause when minutesSinceKickoff is null", () => {
    const d = div({
      attention: [{ kind: "no_scorer", count: 1, fixtureIds: ["f9"], minutesSinceKickoff: null }],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    expect(items[0].sub).toBe("Nothing is being recorded.");
    expect(items[0].sub).not.toMatch(/min ago/);
  });
  // F3 fix, result_missing side: same aggregation as no_scorer above.
  it("F3: result_missing on several fixtures collapses to ONE row, linking to the fixtures tab", () => {
    const d = div({
      attention: [{ kind: "result_missing", count: 2, fixtureIds: ["f9", "f10"] }],
      fixture_names: {
        f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 },
        f10: { home: "Valley CC", away: "Lakeside FC", fixture_no: 10 },
      },
    });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Premier Division · 2 fixtures missing a result");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division?tab=fixtures");
  });
});

describe("desk.* copy (review round 3 — pluralization and subject-verb agreement)", () => {
  it("C2: exactly 1 unscheduled fixture reads singular, not '1 fixtures unscheduled'", () => {
    const d = div({ attention: [{ kind: "unscheduled", count: 1 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "unscheduled");
    expect(item?.title).toBe("Premier Division · 1 fixture unscheduled");
  });
  it("C2: more than 1 reads plural", () => {
    const d = div({ attention: [{ kind: "unscheduled", count: 3 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "unscheduled");
    expect(item?.title).toBe("Premier Division · 3 fixtures unscheduled");
  });
  it("C3: exactly 1 registration waiting reads singular, not '1 registrations waiting'", () => {
    const d = div({ attention: [{ kind: "registrations_waiting", count: 1 }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "registrations_waiting");
    expect(item?.title).toBe("1 registration waiting for approval");
    // M1 enumeration (fix round I): "Review" must land on the tab that HOLDS
    // the pending registration. The hub's default tab is `settings`; the
    // registrants table (and its approve control) is on `registrants`.
    expect(item?.action.href).toBe("/o/org/c/comp/registration?tab=registrants");
  });
  // W2a (addendum 9). Empty case first: no attention, no row.
  it("W2a needs_decision: no held fixture builds no row", () => {
    expect(needsYouItems(en, desk(div({ attention: [] })), names, "org", "comp", "en")).toEqual([]);
  });
  it("W2a needs_decision: ONE held fixture names its match and opens its console, red, with the Settle label", () => {
    const d = div({
      attention: [{ kind: "needs_decision", count: 1, fixtureIds: ["f9"] }],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "needs_decision", severity: "red" });
    expect(items[0].title).toBe("Premier Division · Riverside FC v Summit CC needs a decision");
    expect(items[0].sub).toBe(en["desk.needsYou.needs_decision.sub"]);
    expect(items[0].action).toEqual({ label: "Settle the match", href: "/o/org/c/comp/d/premier-division/f/9" });
  });
  it("W2a needs_decision: several held fixtures collapse to ONE counted row opening the fixtures tab", () => {
    const d = div({
      attention: [{ kind: "needs_decision", count: 2, fixtureIds: ["f9", "f10"] }],
      fixture_names: {
        f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 },
        f10: { home: "Valley CC", away: "Lakeside FC", fixture_no: 10 },
      },
    });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Premier Division · 2 fixtures need a decision");
    expect(items[0].action.href).toBe("/o/org/c/comp/d/premier-division?tab=fixtures");
  });
  it("W2a needs_decision: a held bracket reads its red pill, never Finished (red attention outranks the phase)", () => {
    const attention: Attention[] = [{ kind: "needs_decision", count: 1, fixtureIds: ["f9"] }];
    const html = renderToStaticMarkup(<PhasePill dict={en} phase="finished" attention={attention} />);
    expect(html).toContain('data-pill="needs_decision"');
    expect(html).not.toContain("Finished");
  });
  it("K1: needs_fixtures builds a row naming the stage, with the fixtures-tab action", () => {
    const d = div({ attention: [{ kind: "needs_fixtures", stageName: "Finals" }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "needs_fixtures");
    expect(item?.severity).toBe("red");
    expect(item?.title).toBe("Premier Division · no fixtures yet in Finals");
    // No verb agrees with the user-typed, usually-plural stage name.
    expect(item?.title).not.toContain("Finals has");
    expect(item?.action).toEqual({ label: "Open fixtures", href: "/o/org/c/comp/d/premier-division?tab=fixtures" });
  });
  it("C4: masthead division count reads singular at n=1, plural otherwise", () => {
    expect(plural(en, "desk.masthead.divisions", 1, "en")).toBe("1 division");
    expect(plural(en, "desk.masthead.divisions", 2, "en")).toBe("2 divisions");
  });
  it("C1: a plural-looking stage name does not trigger subject-verb agreement on the title", () => {
    const d = div({ attention: [{ kind: "needs_draw", door: "compute" as const, stageName: "Finals" }] });
    const items = needsYouItems(en, desk(d), names, "org", "comp", "en");
    const item = items.find((i) => i.kind === "needs_draw");
    expect(item?.title).not.toContain("Finals has");
    expect(item?.title).toBe("Premier Division · no draw yet for Finals");
  });
});

describe("DivisionLedger", () => {
  // IMPORTANT (review 7): the phone card's red action was not gated on
  // `canEdit`, while `needsYouItems` on the page above it always has been. A
  // viewer — an ordinary org role that reaches this page, and one RS005
  // deliberately let in — was handed a full-width primary "Compute proposal"
  // landing on a tab where the progression panel returns null for them. That
  // is instance twelve's shape, one audience over.
  it("a viewer sees the state but is never handed a button for work the landing page will not let them do", () => {
    const blocked = div({
      phase: "setting_up", played: 0, total: 4,
      attention: [{ kind: "needs_draw", stageName: "Finals", door: "compute" }],
    });
    const row = { id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: blocked, statusLine: "0 of 4 played" };
    const editor = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z" rows={[row]} />,
    );
    const viewer = renderToStaticMarkup(
      <DivisionLedger canEdit={false} dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z" rows={[row]} />,
    );
    // The editor IS offered the action — otherwise this test passes on a
    // ledger that never renders one, and proves nothing.
    expect(editor).toContain(en["progression.computeCta"]);
    expect(viewer).not.toContain(en["progression.computeCta"]);
    // ...and the viewer still SEES that the division is blocked: the fix must
    // not hide the state along with the button.
    expect(viewer).toContain('data-pill="needs_draw"');
    expect(viewer).toContain("0 of 4 played");
  });

  it("row carries the sport glyph, the status line, the phase and no monogram letter", () => {
    const d = div({ phase: "finished", played: 15, total: 15 });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: d, statusLine: "15 of 15 played · complete" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="finished"');
    expect(html).toContain("⚽");
    expect(html).toContain("15 of 15 played · complete");
    expect(html).toContain('href="/o/org/c/comp/d/premier-division"');
    // V2 fix (review round 1): the pill is the one thing that must survive
    // every width, so it's rendered TWICE — inline under the name (visible
    // below `md`) and in the dedicated column (visible at `md`+) — CSS
    // alone decides which copy shows; neither width is ever pill-less.
    expect(html.match(/data-pill="finished"/g)?.length).toBe(2);
    // V4 fix: no next fixture on a settled row prints nothing at all.
    // V5 fix: the ledger no longer renders its own "Divisions · N" heading
    // — the page's existing "Divisions" heading owns the count now.
    expect(html).not.toContain("Divisions · 1");
  });
  // F1 regression (final review, Critical), toothless-guard fix: the OLD
  // assertion here was `not.toMatch(/Nothing scheduled yet/)` against a
  // hand-typed, already-correct "15 of 15 played · complete" statusLine —
  // that string lives only at entity-card.tsx's `card.next.none`, which
  // this component never renders, on a FINISHED row that could never have
  // produced it anyway. Vacuous twice over. This test drives the REAL
  // `resolvePhase` + `statusLine` functions over the exact live repro (a
  // started division, one active stage with 6 generated fixtures, none
  // carrying a time) and checks the LIVE copy renders the played/unscheduled
  // counts a reader actually needs.
  it("F1: a started division with generated-but-unscheduled fixtures renders setting_up with its played/unscheduled counts", () => {
    const phaseInput: PhaseInput = {
      divisionStatus: "active",
      stages: [{ id: "s1", name: "League", seq: 1, status: "active", hasFixtures: true, timing: null, sourceReady: false, proposal: "none" as const }],
      fixtures: Array.from({ length: 6 }, (_, i) => ({
        id: `f${i}`, status: "scheduled", scheduledAt: null, startedAt: null, eventCount: 0, matchMinutes: 90, hasScorer: false,
        stageId: "s1", awaitsSeedDraw: false, awaitsSettle: false,
      })),
      now: "2026-09-05T09:00:00Z",
      tz: "Europe/London",
      awaitingRegistrations: 0,
    };
    const phase = resolvePhase(phaseInput);
    const attention = resolveAttention(phaseInput);
    const line = statusLine(en, {
      phase, played: 0, total: 6, unscheduled: 6, inPlay: 0, entrants: 4,
      next: null, needsDrawStageName: null, locale: "en", displayTz: "Europe/London", now: "2026-09-05T09:00:00Z",
    });
    const d = div({ phase, played: 0, total: 6, unscheduled: 6, next: null, attention });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: d, statusLine: line }]} />,
    );
    expect(phase).toBe("setting_up");
    expect(html).toContain('data-phase="setting_up"');
    expect(html).toContain("0 of 6 played");
    expect(html).toContain("6 unscheduled");
  });
  it("renders a row without pill or next line when the desk summary is unavailable", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: null, desk: null, statusLine: "10 of 15 played" }]} />,
    );
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-phase="unknown"');
    expect(html).not.toContain("data-pill=");
    expect(html).toContain("10 of 15 played");
  });
  it("uses the uploaded logo instead of the glyph when present", () => {
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "X", slug: "x", sportKey: "football", logoUrl: "https://cdn/x.png", desk: div(), statusLine: "s" }]} />,
    );
    expect(html).toContain('src="https://cdn/x.png"');
    expect(html).not.toContain("⚽");
  });
  it("mobile composition (review round 1, owner ruling): the pill and the full status line render in the SAME block as the name, and the two compositions stay each other's mutually-exclusive siblings", () => {
    const d = div({
      phase: "setting_up", played: 28, total: 28,
      attention: [{ kind: "needs_draw", door: "compute" as const, stageName: "Finals" }],
    });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{
          id: "d1", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: d,
          statusLine: "28 of 28 played · Finals not drawn",
        }]} />,
    );
    // The mobile block and the desktop block are markup-distinguishable
    // siblings — a future change that deletes one branch (rather than
    // editing it) makes one of these substrings disappear and fails here.
    expect(html).toContain("p-4 md:hidden");
    expect(html).toMatch(/hidden items-center gap-3[^"]*md:grid/);
    const mobileBlock = html.slice(html.indexOf("p-4 md:hidden"), html.indexOf("hidden items-center gap-3"));
    expect(mobileBlock).toContain("U16 Cup");
    // The pill renders in the mobile block itself — not behind a `hidden`
    // wrapper of its own.
    expect(mobileBlock).toContain('data-pill="needs_draw"');
    // The full status line, unclamped/untruncated.
    expect(mobileBlock).toContain("28 of 28 played · Finals not drawn");
  });
  it("mobile action button: absent without a red attention, 'Compute proposal' with needs_draw", () => {
    const noAttention = div({ phase: "scheduled", attention: [] });
    const htmlNone = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: noAttention, statusLine: "s" }]} />,
    );
    expect(htmlNone).not.toContain("Compute proposal");
    expect(htmlNone).not.toContain("btn-primary");

    const needsDraw = div({ phase: "setting_up", attention: [{ kind: "needs_draw", door: "compute" as const, stageName: "Finals" }] });
    const htmlAction = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: needsDraw, statusLine: "s" }]} />,
    );
    expect(htmlAction).toContain("Compute proposal");
    expect(htmlAction).toContain('href="/o/org/c/comp/d/u16-cup?tab=fixtures"');
  });
  it("K1: mobile action button for needs_fixtures — the row carries the action, not just the pill", () => {
    const d = div({ phase: "scheduled", played: 6, total: 6, attention: [{ kind: "needs_fixtures", stageName: "Finals" }] });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: d, statusLine: "6 of 6 played" }]} />,
    );
    expect(html).toContain("Open fixtures");
    expect(html).toContain('href="/o/org/c/comp/d/u16-cup?tab=fixtures"');
    expect(html).toContain('data-pill="needs_fixtures"');
  });
  // F3 fix (final review, Important): the mobile card's own red action
  // button reads `no_scorer.fixtureIds` now, not a single `fixtureId` —
  // exercised here separately from needs-you.tsx's copy of the same rule.
  it("mobile action button: no_scorer with ONE fixture deep-links to it; with several, to the fixtures tab", () => {
    const oneScorerless = div({
      phase: "match_day",
      attention: [{ kind: "no_scorer", count: 1, fixtureIds: ["f9"], minutesSinceKickoff: 5 }],
      fixture_names: { f9: { home: "Riverside FC", away: "Summit CC", fixture_no: 9 } },
    });
    const htmlOne = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: oneScorerless, statusLine: "s" }]} />,
    );
    expect(htmlOne).toContain("Open scoring");
    expect(htmlOne).toContain('href="/o/org/c/comp/d/premier-division/f/9"');

    const manyScorerless = div({
      phase: "match_day",
      attention: [{ kind: "no_scorer", count: 2, fixtureIds: ["f9", "f10"], minutesSinceKickoff: 5 }],
    });
    const htmlMany = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[{ id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: manyScorerless, statusLine: "s" }]} />,
    );
    expect(htmlMany).toContain("Open scoring");
    expect(htmlMany).toContain('href="/o/org/c/comp/d/premier-division?tab=fixtures"');
  });
  it("fix round 2: the desktop next column is dropped ledger-wide when no row has a next fixture — no reserved track, no empty cell", () => {
    const rowA = div({ phase: "finished", played: 15, total: 15, next: null });
    const rowB = div({ division_id: "d2", phase: "finished", played: 28, total: 28, next: null });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[
          { id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: rowA, statusLine: "s1" },
          { id: "d2", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: rowB, statusLine: "s2" },
        ]} />,
    );
    expect(html).not.toContain("minmax(0,1.4fr)");
    // Not just blank — the cell itself must not be emitted, or the Open
    // column shifts into a dead track.
    expect(html).not.toContain('class="text-xs text-slate-900"');
  });
  it("fix round 2: the desktop next column is present ledger-wide when ANY row has a next fixture, and every row emits its cell (even an empty one) so Open stays on the same axis", () => {
    const withNext = div({
      phase: "scheduled",
      next: { home: "Riverside FC", away: "Summit CC", scheduled_at: "2026-09-12T09:00:00Z", in_play: false },
    });
    const withoutNext = div({ division_id: "d2", phase: "finished", next: null });
    const html = renderToStaticMarkup(
      // `now` pinned before the fixture's 2026-09-12 kick-off — F5's fix
      // hides a past-kickoff "next", so this test's own passage of time
      // must not silently start relying on the real wall clock.
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-05T09:00:00Z"
        rows={[
          { id: "d1", name: "Premier Division", slug: "premier-division", sportKey: "football", logoUrl: null, desk: withNext, statusLine: "s1" },
          { id: "d2", name: "U16 Cup", slug: "u16-cup", sportKey: "football", logoUrl: null, desk: withoutNext, statusLine: "s2" },
        ]} />,
    );
    expect(html).toContain("minmax(0,1.4fr)");
    const [, row1, row2] = html.split('data-testid="desk-ledger-row"');
    expect(row1).toContain("Riverside FC");
    expect(row1).toMatch(/<p class="text-xs text-slate-900">[^<]*Riverside FC/);
    // The row WITHOUT a next fixture still emits the (empty) cell.
    expect(row2).not.toContain("Riverside FC");
    expect(row2).toMatch(/<p class="text-xs text-slate-900"><\/p>/);
  });
  // F5 fix (final review, Important): card-stats.ts's shared "next fixture"
  // query has no `>= now()` floor and can hand back a fixture whose
  // kick-off already passed, or one with no time at all — division-ledger's
  // OWN use of that data is what's fixed here (card-stats.ts stays
  // untouched, other surfaces depend on its current shape).
  it("F5: a past kick-off never renders as Next", () => {
    const past = div({
      phase: "scheduled",
      next: { home: "Riverside FC", away: "Harbour CC", scheduled_at: "2026-09-02T11:27:00Z", in_play: false },
    });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-02T12:00:00Z"
        rows={[{ id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: past, statusLine: "s" }]} />,
    );
    expect(html).not.toContain("Riverside FC");
    expect(html).not.toContain("minmax(0,1.4fr)");
  });
  it("F5: a next fixture with no scheduled_at (TBD time) never renders as Next", () => {
    const undated = div({
      phase: "scheduled",
      next: { home: "Riverside FC", away: "Harbour CC", scheduled_at: null, in_play: false },
    });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-02T12:00:00Z"
        rows={[{ id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: undated, statusLine: "s" }]} />,
    );
    expect(html).not.toContain("Riverside FC");
  });
  it("F5: a future, correctly-timed kick-off still renders as Next", () => {
    const future = div({
      phase: "scheduled",
      next: { home: "Riverside FC", away: "Harbour CC", scheduled_at: "2026-09-02T12:30:00Z", in_play: false },
    });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-02T12:00:00Z"
        rows={[{ id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: future, statusLine: "s" }]} />,
    );
    expect(html).toContain("Riverside FC");
  });
  it("F5: an in-play fixture always renders as Now, even with no scheduled_at", () => {
    const live = div({
      phase: "match_day",
      next: { home: "Riverside FC", away: "Harbour CC", scheduled_at: null, in_play: true },
    });
    const html = renderToStaticMarkup(
      <DivisionLedger canEdit dict={en} org="org" comp="comp" locale="en" now="2026-09-02T12:00:00Z"
        rows={[{ id: "d1", name: "Premier", slug: "premier", sportKey: "football", logoUrl: null, desk: live, statusLine: "s" }]} />,
    );
    expect(html).toContain("Now: Riverside FC v Harbour CC");
  });
});
