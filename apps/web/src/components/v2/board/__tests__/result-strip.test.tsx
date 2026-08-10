import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleResultStrip } from "@/components/v2/board/result-strip";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { ScheduleMetrics, ScheduleSolverInfo } from "@/server/api-v1/schemas";

// Task 11 — the result strip is what makes the solver's ANYTIME contract honest
// to the organiser. It returns the best board found inside a time budget, which
// may be neither optimal nor complete, so every assertion below is about the
// strip refusing to imply a completeness the run did not deliver.
//
// Rendered with renderToStaticMarkup (no jsdom in this repo); useMsg() falls
// back to the English catalog outside a DictProvider, so the copy asserted here
// is the real dictionary copy, not a stand-in.
//
// DOM probes anchor on `="` — React serialises an omitted prop as
// `"$undefined"`, so a bare `data-tone` substring passes in both states.

const metrics = (over: Partial<ScheduleMetrics> = {}): ScheduleMetrics => ({
  // Deliberately three DIFFERENT durations so a swapped cell cannot pass.
  makespan_minutes: 260, // 4h 20m
  worst_idle_gap_minutes: 45,
  court_imbalance_minutes: 25,
  placed: 22,
  total: 22,
  ...over,
});

const solver = (over: Partial<ScheduleSolverInfo> = {}): ScheduleSolverInfo => ({
  engine: "z3",
  status: "ok",
  tiers_completed: 4,
  tiers_total: 4,
  budget_expired: false,
  elapsed_ms: 3200,
  moved: 6,
  ...over,
});

// React escapes `'` to `&#x27;` in text nodes. Decode it back so the copy
// assertions read as the copy; attribute delimiters are literal `"` either way,
// so the `="` anchoring below is unaffected.
const render = (m: ScheduleMetrics, s: ScheduleSolverInfo) =>
  renderToStaticMarkup(
    <DictProvider dict={uiEn} locale="en">
      <ScheduleResultStrip metrics={m} solver={s} />
    </DictProvider>,
  ).replace(/&#x27;/g, "'");

/** The rendered text of the provenance line, comment markers stripped (React
 *  separates adjacent text expressions with `<!-- -->` in SSR output). Reading
 *  the WHOLE line is what lets an engine-label assertion be exact: "Solver" is a
 *  prefix of "Solver, then refined", so a substring check can be satisfied by
 *  the wrong label. */
const provenance = (html: string): string => {
  const m = /data-testid="schedule-result-provenance"[^>]*>(.*?)<\/p>/s.exec(html);
  if (!m) throw new Error("no provenance line rendered");
  return m[1]!.replace(/<!--[\s\S]*?-->/g, "");
};

describe("ScheduleResultStrip — the numbers", () => {
  it("renders every metric against its OWN label, and the e2e testid", () => {
    const html = render(metrics(), solver());
    expect(html).toContain('data-testid="schedule-result-strip"');
    // Label -> value adjacency, not bare presence: transposing two cells must fail.
    expect(html).toMatch(/Total length<\/dt><dd[^>]*>4h 20m<\/dd>/);
    expect(html).toMatch(/Longest gap<\/dt><dd[^>]*>45m<\/dd>/);
    expect(html).toMatch(/Court spread<\/dt><dd[^>]*>25m<\/dd>/);
    expect(html).toMatch(/Scheduled<\/dt><dd[^>]*>22 \/ 22<\/dd>/);
  });

  /**
   * Task 11 (placement cutover) — `data-engine` is the ONLY DOM-observable
   * proof of which engine produced a board: the rendered provenance text
   * gives "optimized" the SAME copy as `z3` in every locale (`it.each` below),
   * so an e2e spec asserting the cutover has nothing else to read. Anchored on
   * `="` for every value, never bare presence — React serialises an omitted
   * prop as the string `"$undefined"`, so a probe that only checked the
   * attribute existed would pass whether or not `solver.engine` ever reached
   * the DOM at all.
   */
  it.each(["greedy", "z3", "z3+lns", "optimized"] as const)(
    "carries engine '%s' on data-engine, not a different value",
    (engine) => {
      const html = render(metrics(), solver({ engine }));
      expect(html).toContain(`data-engine="${engine}"`);
      for (const other of ["greedy", "z3", "z3+lns", "optimized"] as const) {
        if (other !== engine) expect(html).not.toContain(`data-engine="${other}"`);
      }
    },
  );

  it("reports the run's provenance in the organiser's words, never the engine key", () => {
    const html = render(metrics(), solver({ engine: "z3+lns", elapsed_ms: 3200, moved: 6 }));
    expect(html).toContain("Solver, then refined");
    // Scoped to the READABLE copy line, not the whole markup: Task 11 added
    // `data-engine="z3+lns"`, a machine-readable attribute for e2e that is
    // deliberately NOT organiser-facing copy — `provenance()` strips it out,
    // so this still pins "the engine key never leaks into the sentence a
    // person reads" without also forbidding the DOM hook that carries it.
    expect(provenance(html)).not.toContain("z3+lns");
    expect(html).toContain("3.2s");
    expect(html).toContain("6 matches moved");
  });

  /**
   * ALL THREE engine values, one case each, asserted on the provenance line
   * ITSELF.
   *
   * This label is the only thing anywhere on screen that names which solver
   * produced the board — a greedy fallback and an optimised run are otherwise
   * indistinguishable to an organiser, because a greedy board is also a valid
   * board. This file used to pin `z3+lns` and nothing else, and the e2e regex
   * accepts all three, so the `greedy` and `z3` entries of `ENGINE_KEY` were
   * unpinned: SWAPPING THEM survived every test in the branch. A quick-pass
   * board would have told the organiser it was optimised, and an optimised one
   * that it was not.
   */
  it.each([
    ["greedy", "Quick pass"],
    ["z3", "Solver"],
    ["z3+lns", "Solver, then refined"],
    // Task 06b: same neutral copy as `z3` — the organiser is never told
    // which solver ran, only whether one did.
    ["optimized", "Solver"],
  ] as const)("names the '%s' engine exactly '%s'", (engine, label) => {
    const html = render(metrics(), solver({ engine, elapsed_ms: 3200, moved: 6 }));
    expect(provenance(html)).toBe(`${label} · 3.2s · 6 matches moved`);
  });

  it("says 'nothing moved' rather than '0 matches moved'", () => {
    const html = render(metrics(), solver({ moved: 0 }));
    expect(html).toContain("nothing moved");
    expect(html).not.toContain("0 matches moved");
  });

  /** A card that was never on the timetable cannot be MOVED. A re-flow over an
   *  unscheduled stage places the whole board, and "12 matches moved" is wrong
   *  about every single one of them. */
  it("says 'scheduled', not 'moved', when every card was placed for the first time", () => {
    const html = render(metrics(), solver({ moved: 12, seeded: 12 }));
    expect(html).toContain("12 matches scheduled");
    expect(html).not.toContain("12 matches moved");
  });

  /** The discriminator. Same `moved`, and `moved === placed` in this fixture
   *  too, so a component that inferred "was this seeded" from the metrics rather
   *  than reading `solver.seeded` would relabel this genuine re-flow as well. */
  it("keeps 'moved' for a re-flow that seeded nothing", () => {
    const html = render(metrics({ placed: 12, total: 12 }), solver({ moved: 12, seeded: 0 }));
    expect(html).toContain("12 matches moved");
    expect(html).not.toContain("12 matches scheduled");
  });

  /** A mixed run keeps the plain wording — it is the sentence that is true of
   *  the set as a whole, and a third string for a rare case is worse copy. */
  it("keeps 'moved' when only some of the cards were seeded", () => {
    const html = render(metrics(), solver({ moved: 12, seeded: 5 }));
    expect(html).toContain("12 matches moved");
    expect(html).not.toContain("12 matches scheduled");
  });

  /** BUILD and POLISH never send the field, and neither does a server one
   *  deploy behind. */
  it("keeps 'moved' when the wire carries no seeded count", () => {
    const html = render(metrics(), solver({ moved: 12 }));
    expect(html).toContain("12 matches moved");
  });
});

describe("ScheduleResultStrip — the anytime contract", () => {
  it("budget_expired: true names how far the solver got before it stopped", () => {
    const html = render(metrics(), solver({ budget_expired: true, tiers_completed: 2 }));
    expect(html).toContain('data-testid="schedule-result-budget"');
    expect(html).toContain("2 of 4 targets improved");
  });

  /** The denominator is the WIRE's, not a constant in the component. The
   *  fixture's 4 agrees with today's ladder, so the only way to tell the two
   *  apart is to send a value that does not: a component still reading its own
   *  `IMPROVEMENT_TARGETS` renders "2 of 4" here and is caught. */
  it("takes the target count from tiers_total rather than a hardcoded 4", () => {
    const html = render(metrics(), solver({ budget_expired: true, tiers_completed: 2, tiers_total: 7 }));
    expect(html).toContain("2 of 7 targets improved");
    expect(html).not.toContain("2 of 4 targets improved");
  });

  /**
   * THE reflow-timeout defect (Task 12).
   *
   * The repair solver has no tier ladder — `reflowExisting` sets
   * `tiersCompleted: 0` and stays there deliberately, because reporting a
   * number from a ladder it never walked would make an optimality claim nothing
   * proved. `tiers_total` is still the build ladder's 4 (pinned by
   * schedule-solver-telemetry.test.ts for all three modes), so a strip that
   * reads only those two numbers renders "0 of 4 targets improved" — true, and
   * useless: it names a scale the run was never on.
   *
   * The two numbers here are IDENTICAL to the build case below except for
   * `mode`, which is the whole point: nothing else in the payload can tell a
   * repair timeout from a build that expired before finishing its first tier.
   */
  it("a reflow timeout gets its own sentence, not '0 of 4 targets improved'", () => {
    const html = render(
      metrics(),
      solver({ mode: "reflow", budget_expired: true, tiers_completed: 0, tiers_total: 4 }),
    );
    expect(html).toContain('data-testid="schedule-result-budget"');
    expect(html).toContain("nothing already on the board was moved");
    expect(html).not.toContain("targets improved");
    expect(html).not.toContain("0 of 4");
  });

  /** …and the build path keeps the tier sentence on the SAME two numbers, so
   *  the discriminator is provably `mode` and not `tiers_completed === 0`. */
  it("a build that expired before its first tier still counts targets", () => {
    const html = render(
      metrics(),
      solver({ mode: "build", budget_expired: true, tiers_completed: 0, tiers_total: 4 }),
    );
    expect(html).toContain("0 of 4 targets improved");
    expect(html).not.toContain("nothing already on the board was moved");
  });

  /** A server one deploy behind sends no `mode`. The tier sentence is what it
   *  rendered before the field existed, so absence must not change it. */
  it("keeps the tier sentence when the wire carries no mode", () => {
    const html = render(metrics(), solver({ budget_expired: true, tiers_completed: 2 }));
    expect(html).toContain("2 of 4 targets improved");
  });

  it("budget_expired: false does NOT render the note", () => {
    const html = render(metrics(), solver({ budget_expired: false, tiers_completed: 2 }));
    expect(html).not.toContain('data-testid="schedule-result-budget"');
    expect(html).not.toContain("targets improved");
  });

  it("already_optimal reads as a finished job, not a failure", () => {
    const html = render(metrics(), solver({ status: "already_optimal", moved: 0 }));
    expect(html).toContain("nothing left to improve");
    // Tone is the neutral one — an amber "something is wrong" band would be a lie.
    expect(html).toContain('data-tone="plain"');
    expect(html).not.toContain('data-tone="flag"');
  });

  it("solver_busy says the board is valid AND that a retry can do better", () => {
    // Contention here is ordinary and brief — one WASM solver instance per
    // machine, tens of seconds of wait — so it reads as a fact plus a retry,
    // never as an outage. The retry line is also the only thing that explains
    // why two runs on identical input can differ.
    const html = render(metrics(), solver({ status: "solver_busy", engine: "greedy" }));
    expect(html).toContain("the optimiser was busy");
    expect(html).toContain("Try again for a better board.");
    expect(html).toContain('data-tone="plain"');
  });

  it("z3_unavailable says the board is valid, and does NOT promise a retry will help", () => {
    const html = render(metrics(), solver({ status: "z3_unavailable", engine: "greedy" }));
    expect(html).toContain("the optimiser was not available");
    expect(html).toContain("The board is valid, just not optimised.");
    expect(html).not.toContain("Try again");
    expect(html).toContain('data-tone="plain"');
  });

  // Task 06b: the placement era's `z3_unavailable`. Same copy, same tone, by
  // design (the brief's semantic argument: "does not promise a retry will
  // help" is equally true for a placement outage) — this is what proves the
  // two statuses actually share a rendering path rather than one silently
  // falling through a switch with no case (which throws, per the
  // `not_searched` test below).
  it("solver_unavailable says the board is valid, and does NOT promise a retry will help", () => {
    const html = render(metrics(), solver({ status: "solver_unavailable", engine: "greedy" }));
    expect(html).toContain("the optimiser was not available");
    expect(html).toContain("The board is valid, just not optimised.");
    expect(html).not.toContain("Try again");
    expect(html).toContain('data-tone="plain"');
  });

  it("verifier_rejected is a neutral note — no blame, and no alarm colour", () => {
    const html = render(metrics(), solver({ status: "verifier_rejected", engine: "greedy" }));
    expect(html).toContain("Scheduled with the standard scheduler. The board is valid.");
    // The organiser cannot act on an internal fault, so nothing implies they
    // should: no amber band, and nothing pointing at their data or settings.
    expect(html).toContain('data-tone="plain"');
    expect(html).not.toContain('data-tone="flag"');
    expect(html).not.toMatch(/your (setup|settings|data)|check your/i);
  });

  /**
   * `not_searched` — the one status whose job is to REFUSE a claim.
   *
   * The solver could not put this board on its lattice, so it never searched
   * it. The board it arrives with is a valid greedy one; what the run cannot
   * say is whether a better one exists. The behaviour this replaces reported
   * `already_optimal` — a proof — about a board nothing had looked at, so the
   * one thing this copy may never do is imply the board was checked and found
   * good.
   *
   * `statusKey`'s switch has no `default`, so a member with no case returns
   * `undefined` — and MEASURED, that does not render a blank headline, it
   * THROWS out of `lookup` in i18n-runtime and takes the whole strip (a client
   * island on the board) down with it. The first assertion below is still
   * "the strip says something at all", because the render error is what a
   * missing case actually produces and the assertion has to survive being made
   * about a component that rendered.
   */
  it("not_searched says the board was not searched, and never implies it was found good", () => {
    const html = render(metrics(), solver({ status: "not_searched", engine: "greedy" }));
    // Non-blank headline. A missing switch case renders `<p ...></p>` here.
    expect(html).toMatch(/data-testid="schedule-result-headline"[^>]*>[^<]/);
    expect(html).toContain("could not search this board");
    // WHY, and WHAT TO CHANGE. The cause is the organiser's own durations, and
    // unlike `solver_busy` a retry on the same settings reproduces it exactly.
    expect(html).toContain("do not line up on a shared step");
    expect(html).toContain("run it again");
    // Never a quality claim. `already_optimal`'s sentence is the specific thing
    // this member exists to stop being said.
    expect(html).not.toMatch(/nothing left to improve|best arrangement/i);
    expect(html).not.toContain("Optimised.");
  });

  /**
   * AMBER, and the departure from `solver_busy` / `z3_unavailable` is the point.
   *
   * Those two are plain because they are transient and the organiser cannot act
   * on them — the same click a minute later can produce a better board.
   * `not_searched` is neither. It is deterministic (re-running on the same
   * settings reproduces it exactly) and it is caused by a setting the organiser
   * owns, so it is the one case on this strip where "try again" is useless and
   * changing something is the only route to an optimised board. That is the
   * definition of "something here you need to know about your board", which is
   * what amber is reserved for. Filing it beside `verifier_rejected` would
   * leave an organiser believing their board had been optimised as far as it
   * goes, which is the belief this whole status exists to prevent.
   */
  /**
   * ONE SENTENCE PER CAUSE. The six exits `not_searched` can come from used to
   * collapse onto the single generic sentence pinned above ("do not line up on
   * a shared step"), which is at best a partial description of the lattice-cap
   * exit and, for `per_court_grid`, advice that cannot possibly work — no
   * amount of adjusting match/gap/rest fixes a blackout scoped to one court.
   * Each probe string was checked unique to its own reason's dictionary entry,
   * so a swapped mapping in `NOT_SEARCHED_KEY` fails here rather than passing
   * by coincidence.
   */
  it.each([
    ["too_big", "more matches and possible times than it can search"],
    ["window_empty", "ends before this run can even start"],
    ["lattice_unusable", "more possible start times than it can hold at once"],
    ["per_court_grid", "blackout that applies to only one of your courts"],
    ["out_of_time", "already spent working out this board before the optimiser could even be asked"],
    ["no_verdict", "came back with no verdict at all"],
  ] as const)("not_searched_reason '%s' renders its own sentence", (reason, snippet) => {
    const html = render(metrics(), solver({ status: "not_searched", not_searched_reason: reason }));
    expect(html).toContain(snippet);
    // The shared opening clause survives on every reason, so the strip reads
    // as one family of sentences rather than six unrelated ones.
    expect(html).toContain("nothing here claims a better one exists");
  });

  /** `per_court_grid` names the fix explicitly, per the brief: removing the
   *  blackout or applying it to every court, not a generic "adjust settings". */
  it("per_court_grid tells the organiser exactly what to do about the blackout", () => {
    const html = render(
      metrics(),
      solver({ status: "not_searched", not_searched_reason: "per_court_grid" }),
    );
    expect(html).toContain("removing that blackout, or applying it to every court, restores it");
  });

  /** A server one deploy behind sends `status: "not_searched"` with no reason
   *  at all — the pre-existing generic sentence, asserted above, is what that
   *  must keep rendering. This is the negative space: none of the six reason
   *  sentences leak in when the field is absent. */
  it("falls back to the generic sentence when the wire carries no reason", () => {
    const html = render(metrics(), solver({ status: "not_searched" }));
    expect(html).toContain("do not line up on a shared step");
    for (const snippet of [
      "more matches and possible times than it can search",
      "ends before this run can even start",
      "more possible start times than it can hold at once",
      "blackout that applies to only one of your courts",
      "already spent working out this board before the optimiser could even be asked",
      "came back with no verdict at all",
    ]) {
      expect(html).not.toContain(snippet);
    }
  });

  it("not_searched is flagged, unlike the other two 'quick pass' statuses", () => {
    const html = render(metrics(), solver({ status: "not_searched", engine: "greedy" }));
    expect(html).toContain('data-tone="flag"');
    expect(html).not.toContain('data-tone="plain"');
    // The falsifier: a component that flagged every non-`ok` status would pass
    // the line above. These two must stay plain on the SAME complete board.
    for (const status of ["solver_busy", "z3_unavailable"] as const) {
      expect(render(metrics(), solver({ status, engine: "greedy" }))).toContain(
        'data-tone="plain"',
      );
    }
  });
});

describe("ScheduleResultStrip — infeasible is a statement about the PINS", () => {
  // Measured on the engine lane: 20 clean fixtures + 2 contradictory pinned
  // cards returns 20 placed with exactly those 2 dropped. UNSAT is a proof about
  // the pins, so the strip must not tell the organiser their board is impossible.
  it("names the placement split and the pins, and never says the schedule is impossible", () => {
    const html = render(metrics({ placed: 20, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("20 of 22 scheduled");
    expect(html).toContain("2 pinned matches cannot all be kept where they are");
    expect(html).not.toMatch(/impossible|no schedule|cannot be scheduled/i);
    expect(html).toContain('data-tone="flag"');
  });

  it("uses the singular pin sentence when exactly one card was dropped", () => {
    const html = render(metrics({ placed: 21, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("one pinned match cannot be kept where it is");
    expect(html).not.toContain("pinned matches cannot all");
  });

  it("infeasible with a FULL board does not claim anything was dropped", () => {
    const html = render(metrics({ placed: 22, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("everything still found a slot");
    expect(html).not.toContain("scheduled —");
    /**
     * AMBER, deliberately, and the tone is asserted in BOTH directions here
     * because until Task 12 this spec pinned only the headline and the band was
     * whatever `flagged` happened to compute.
     *
     * The decision: this run could not honour every pin. Nothing was dropped,
     * so the numbers are fine — but a match the organiser had pinned has been
     * moved off the time they pinned it to, and they may already have told
     * somebody about it. That is the definition of "something here you need to
     * know about your board", which is what amber is reserved for. A neutral
     * slate band would file it beside `verifier_rejected`, where the organiser
     * genuinely has nothing to do.
     */
    expect(html).toContain('data-tone="flag"');
    expect(html).not.toContain('data-tone="plain"');
  });

  /**
   * THE case the `total - placed` fallback gets wrong, and the only shape that
   * can tell the two apart. Every spec above places the whole unplaced set at
   * the pins' door, so the derivation and the engine's own answer agree and a
   * test built on one of those boards proves nothing.
   *
   * Here four cards are off the board and the engine's proof names TWO of them:
   * the other two lost their slot to something else entirely. Telling the
   * organiser that four pins contradict each other sends them to unpin two cards
   * that were never the problem.
   */
  it("takes the pin count from the engine, not from total - placed", () => {
    const html = render(
      metrics({ placed: 18, total: 22 }),
      solver({ status: "infeasible", contradictory_pins: ["f-3", "f-7"] }),
    );
    expect(html).toContain("18 of 22 scheduled");
    expect(html).toContain("2 pinned matches cannot all be kept where they are");
    expect(html).not.toContain("4 pinned matches");
  });

  /** …and with no field on the wire it still says something, rather than going
   *  blank on the one board that most needs explaining. */
  it("falls back to total - placed when the engine named no pins", () => {
    const html = render(metrics({ placed: 18, total: 22 }), solver({ status: "infeasible" }));
    expect(html).toContain("4 pinned matches cannot all be kept where they are");
  });

  it("a partial board that is NOT infeasible says so without inventing pins", () => {
    const html = render(metrics({ placed: 20, total: 22 }), solver({ status: "ok" }));
    expect(html).toContain("20 of 22 scheduled");
    expect(html).toContain("2 matches could not be placed");
    expect(html).not.toContain("pinned");
    // The status sentence still gets said, on its own line.
    expect(html).toContain("These are the numbers the solver settled on.");
    expect(html).toContain('data-tone="flag"');
  });

  it("a complete board never renders the partial headline", () => {
    const html = render(metrics(), solver());
    expect(html).not.toContain("of 22 scheduled");
    expect(html).not.toContain("could not be placed");
  });
});

/**
 * `lost` — cards the run took OFF a board the organiser already had (R21).
 *
 * It is not "could not be placed". A stage of 22 with 18 placed has 4 cards
 * with no slot, but only the ones that HELD a slot before this run are a slot
 * the organiser has to un-tell somebody about; the rest were never scheduled.
 * Folding the two is exactly what R21 split apart in the engine, and a strip
 * that re-folded them here would undo it.
 */
describe("ScheduleResultStrip — lost slots are not the same as unplaced cards", () => {
  /**
   * THE discriminating fixture. Four cards are off the board (22 - 18) and only
   * TWO of them had a slot to lose. A component deriving the count from
   * `total - placed` renders 4 here and is caught; on any board where the two
   * agree it would pass while measuring the wrong thing.
   */
  it("takes the lost count from the wire, not from total - placed", () => {
    const html = render(
      metrics({ placed: 18, total: 22 }),
      solver({ status: "ok", moved: 6, lost: 2 }),
    );
    expect(html).toContain('data-testid="schedule-result-lost"');
    expect(html).toContain("2 matches lost the slots they had");
    expect(html).not.toContain("4 matches lost");
    // …and the unplaced sentence keeps saying 4, so the two facts stay two facts.
    expect(html).toContain("4 matches could not be placed");
  });

  it("uses the singular sentence for exactly one lost slot", () => {
    const html = render(metrics({ placed: 21, total: 22 }), solver({ lost: 1 }));
    expect(html).toContain("One match lost the slot it had");
    expect(html).not.toContain("lost the slots they had");
  });

  /** A run that dropped nothing must not render an empty accusation. `moved`
   *  is deliberately non-zero: a component keying the line off the wrong field
   *  renders it here. */
  it("says nothing at all when the run lost no slots", () => {
    const html = render(metrics(), solver({ moved: 6, lost: 0 }));
    expect(html).not.toContain('data-testid="schedule-result-lost"');
    expect(html).not.toContain("lost the slot");
  });

  /** BUILD without a `current` board reports 0 by definition, and a server one
   *  deploy behind sends no field at all. Neither is "nothing was lost proven". */
  it("says nothing when the wire carries no lost count", () => {
    const html = render(metrics({ placed: 18, total: 22 }), solver());
    expect(html).not.toContain('data-testid="schedule-result-lost"');
  });
});
