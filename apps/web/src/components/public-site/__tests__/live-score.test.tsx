// `LiveScoreBody` — the pure score-strip/set-scoreboard/period/discipline
// renderer. Real React SSR (`renderToStaticMarkup`, `environment: "node"`,
// no jsdom needed) — `LiveScoreBody` is hookless.
//
// Task 14 (spectator surface W1) retired this file's own `LiveScore`
// transport wrapper — the fixture detail page now renders `<MatchCentre>`
// directly, which calls `useLiveFixture` itself (see `use-live-fixture.
// test.ts` for that transport's own coverage: initial render, a poll tick
// replacing the WHOLE document, a failed poll keeping last-known data, never
// arming a poll on an already-decided fixture, and the unmount guard — all
// of it now proven once, not duplicated here and in `LiveScore`). The
// R3.5/Task O "decided sentence updates on a live poll" behaviour this file
// used to prove through `LiveScore`'s own `decidedTemplates` prop is
// superseded by `MatchCentre`'s document-driven `header.statusLine`
// (`court-card.tsx`), which recomputes from the SAME fresh `match_centre`
// document every poll/realtime tick — proven live (not just statically) by
// the Task 14 e2e pass, per rule 2 ("pure-builder tests cannot see wiring").
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { LiveScoreBody } from "../live-score";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";

const entrantNames = { W: "Riverside FC", L: "Oakdale United" };

// Review round 2 — OPEN item from Task 11 Important 3: the earlier round's
// localisation had NO test that could fail if reverted, since every prior
// render used the English dict (the fallback), so "Live"/"Ended"/"Winner:"
// stayed in the output whether `t()` ran or the raw English literal was
// still hardcoded. These render with the FRENCH dictionary specifically and
// assert the FRENCH words — a revert to hardcoded English would fail every
// one of these.
describe("LiveScoreBody — localisation actually applies (not just wired to an English fallback)", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

  it("in_play, rendered with the FRENCH dict: the French word appears, the English 'Live' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "in_play", summary: { headline: "1 – 0" }, outcome: null }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.status.live"] as string); // "En direct"
    expect(html).not.toContain(">Live<");
  });

  it("decided, rendered with the FRENCH dict: the French word appears, the English 'Ended' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "decided", summary: { headline: "2 – 1" }, outcome: null }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.status.decided"] as string); // "Terminé"
    expect(html).not.toContain("Ended");
  });

  it("a winner line, rendered with the FRENCH dict: the French word appears, the English 'Winner:' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "decided", summary: { headline: "2 – 1" }, outcome: { kind: "win", winner: "W" } }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.winner"] as string); // "Vainqueur :"
    expect(html).not.toContain("Winner:");
  });
});

// Review round 2 — NEW IMPORTANT B: the DB's `fixtures.status` vocabulary
// (server/usecases/stages.ts:2142-2156) carries values beyond in_play/
// decided/finalized/scheduled — abandoned, cancelled, forfeited, postponed,
// walkover — each of which used to collapse into the generic
// `matchCentre.status.other` ("Not played") on the legacy fixture page.
// Task 14b — the two headings below were genuinely hardcoded, unconditional
// English (task-14-review.md's OWED item 1): `SummaryTab`'s `!cricket`
// fallback (`summary-tab.tsx:42-49`) renders `LiveScoreBody` for EVERY
// non-cricket sport, so a football/hockey fixture with period or card data
// hit this on the Summary tab, in every locale, in production, before this
// fix.
describe("LiveScoreBody — period/discipline headings are localised, not hardcoded English", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
  const twoSideNames = { home: "Riverside FC", away: "Oakdale United" };
  const dataWithPeriodsAndDiscipline = {
    status: "in_play",
    summary: {
      headline: "2 – 1",
      perSide: [
        { entrantId: "home", line: "2" },
        { entrantId: "away", line: "1" },
      ],
      detail: {
        periods: [{ phase: "Q1", home: 1, away: 0 }],
        discipline: [{ side: "home" as const, classKey: "yellow" }],
      },
    },
    outcome: null,
  };

  it("'Goals by period' heading, rendered with the FRENCH dict: the French word appears, the English heading does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriodsAndDiscipline}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.goalsByPeriod"] as string); // "Buts par période"
    expect(html).not.toContain("Goals by period");
  });

  it("'Discipline' heading, rendered with the FRENCH dict: the French word appears, the English heading does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriodsAndDiscipline}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    // French is the SAME cognate word ("Discipline") — assert the heading
    // renders through `t()` at all (not a coincidental literal survival) by
    // checking the Spanish dict instead, which genuinely differs ("Disciplina").
    expect(html).toContain(fr["matchCentre.discipline"] as string);
  });

  // ---- Review MINOR 9, at the MATCH-CENTRE surface (2026-09-10) ----
  //
  // `_THEMES.md` §2a's label ruling is written for the overlay, but
  // `disciplineLabel` is shared: the public match page's discipline panel
  // rendered "Bench minor" / "Game misconduct" in English on a French, Spanish
  // or Dutch page too. The heading above it was already localised, which made
  // the untranslated row beneath it read as a bug rather than an omission.
  //
  // NON-ENGLISH ON PURPOSE, and on a class whose English is TWO WORDS: the
  // one-word classes ("Minor", "Major") are the ones where a lazy translation
  // is hardest to distinguish from the class key.
  const withClasses = (classKeys: string[]) => ({
    status: "in_play",
    summary: {
      headline: "2 – 1",
      perSide: [
        { entrantId: "home", line: "2" },
        { entrantId: "away", line: "1" },
      ],
      detail: { discipline: classKeys.map((classKey) => ({ side: "home" as const, classKey })) },
    },
    outcome: null,
  });

  it("the card LABEL is localised too, not just the heading above it (MINOR 9)", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={withClasses(["bench_minor", "game_misconduct"])}
        entrantNames={twoSideNames}
        sportKey="icehockey"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["overlay.card.benchMinor"] as string);
    expect(html).toContain(fr["overlay.card.gameMisconduct"] as string);
    expect(html, "the anglicised class key is still on the page").not.toContain("Bench minor");
    expect(html, "the anglicised class key is still on the page").not.toContain("Game misconduct");
    expect(html, "the key leaked instead of its copy").not.toContain("overlay.card.");
  });

  it("the same labels in DUTCH — a second locale, so one lucky cognate cannot carry it", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={withClasses(["bench_minor", "game_misconduct"])}
        entrantNames={twoSideNames}
        sportKey="icehockey"
        decidedTemplates={emptyTemplates}
        dict={nl as Dict}
      />,
    );
    expect(html).toContain(nl["overlay.card.benchMinor"] as string);
    expect(html).toContain(nl["overlay.card.gameMisconduct"] as string);
    expect(html).not.toContain("Bench minor");
  });

  // ---- Review MINOR 8: F14's blast radius reaches this surface ----
  //
  // `disciplineList` is read by the overlay AND by this panel, so F14's ruling
  // ("a malformed row is skipped, not fatal") changed the match page too, from
  // "one bad row hides every card" to "show the readable rows". Strictly
  // better and exactly what §2a says — but no test asserted it HERE, and the
  // panel is gated on `discipline !== null`, so this surface is where the old
  // behaviour was visible as a whole missing panel.
  it("one malformed discipline row does not erase the panel — the readable rows still render (MINOR 8)", () => {
    const data = {
      status: "in_play",
      summary: {
        headline: "2 – 1",
        perSide: [
          { entrantId: "home", line: "2" },
          { entrantId: "away", line: "1" },
        ],
        detail: {
          discipline: [
            { side: "home" as const, classKey: "yellow" },
            { side: "sideways", classKey: "yellow" }, // unreadable side
            { side: "away" as const, classKey: 7 }, // unreadable class
            { side: "away" as const, classKey: "red" },
          ],
        },
      },
      outcome: null,
    };
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={data as never}
        entrantNames={twoSideNames}
        sportKey="icehockey"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
      />,
    );
    expect(html, "the whole panel vanished on one bad row").toContain(
      en["matchCentre.discipline"] as string,
    );
    expect(html).toContain(en["overlay.card.yellow"] as string);
    expect(html).toContain(en["overlay.card.red"] as string);
    // The other direction, or "skip the bad row" is satisfied by rendering
    // every row regardless: exactly two rows survived, not four.
    expect(html.split("Riverside FC").length - 1, "one row per READABLE entry").toBe(2);
  });

  it("a discipline list whose EVERY row is unreadable renders no panel at all — null still means 'nothing to show'", () => {
    const data = {
      status: "in_play",
      summary: {
        headline: "2 – 1",
        perSide: [
          { entrantId: "home", line: "2" },
          { entrantId: "away", line: "1" },
        ],
        detail: { discipline: [{ side: "sideways", classKey: "yellow" }] },
      },
      outcome: null,
    };
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={data as never}
        entrantNames={twoSideNames}
        sportKey="icehockey"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
      />,
    );
    expect(html, "an empty array would paint a heading with no rows under it").not.toContain(
      en["matchCentre.discipline"] as string,
    );
  });

  it("'Discipline' heading with the SPANISH dict reads 'Disciplina', never the English word", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriodsAndDiscipline}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={es as Dict}
      />,
    );
    expect(html).toContain(es["matchCentre.discipline"] as string); // "Disciplina"
    expect(html).not.toContain(">Discipline<");
  });

  it("with no dict prop (the English fallback), both headings still read in English — proves the default path is unbroken", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriodsAndDiscipline}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
      />,
    );
    expect(html).toContain("Goals by period");
    expect(html).toContain(">Discipline<");
  });
});

// R11 fix round, C7 — `SummaryTab`'s non-cricket fallback mounts
// `LiveScoreBody` BELOW a `CourtCard` that already renders the identical
// court-slab scorebug (same wrapper class, same score), so the two rendered
// side by side print the score twice. `suppressScorebug` lets that ONE
// caller drop the duplicate; every other caller (this describe block's own
// tests above, and `match-centre.tsx`'s no-document fallback, which has NO
// `CourtCard` above it) must render byte-identical to before, which is why
// the prop defaults to `false`.
describe("LiveScoreBody — suppressScorebug (R11 fix round, C7)", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
  const twoSideNames = { home: "Riverside FC", away: "Oakdale United" };
  const dataWithPeriods = {
    status: "in_play",
    summary: {
      headline: "2 – 1",
      perSide: [
        { entrantId: "home", line: "2" },
        { entrantId: "away", line: "1" },
      ],
      detail: { periods: [{ phase: "Q1", home: 1, away: 0 }] },
    },
    outcome: null,
  };

  it("defaults to false — omitting the prop entirely renders the scorebug exactly as before (byte-identical for every existing caller)", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriods}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
      />,
    );
    expect(html).toContain('class="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"');
    expect(html).toContain(">Live<");
  });

  it("suppressScorebug=true drops the court-slab card AND the decided line, but keeps the goals-by-period table below it", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithPeriods}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
        suppressScorebug
      />,
    );
    expect(html).not.toContain("bg-court");
    expect(html).not.toContain(">Live<");
    // The per-period breakdown is what the court card does NOT carry — it
    // must survive the suppression, or the fix stripped more than the
    // duplicate headline.
    expect(html).toContain(en["matchCentre.goalsByPeriod"] as string);
  });

  it("suppressScorebug=true also drops the decided-line sentence (the court card carries the SAME sentence via header.statusLine)", () => {
    const decidedTemplates: DecidedOutcomeTemplates = {
      tie: "",
      plain: "{winner} won",
      shootoutPlain: "",
      byMethod: {},
    };
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "decided", summary: null, outcome: { kind: "win", winner: "home" } }}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={decidedTemplates}
        dict={en as Dict}
        suppressScorebug
      />,
    );
    expect(html).not.toContain("won");
  });
});

// Task 14c (task-14b-review.md Remaining-English list) — `SetScoreboard`'s
// "Score by {unit}" heading and its per-column "{unit} {n}" label were both
// hardcoded English, fed by `setBreakdown()`'s own then-English `unit` value
// ("Game"/"Set") — `lib/public-site.ts:303`. `unit` is now a dictionary-key
// suffix ("game"/"set", never a display word), resolved here through
// `matchCentre.scoreByUnit`/`matchCentre.unit.<unit>` (heading) and the SAME
// `matchCentre.col.<unit>` family `sets-tab.tsx` already reads off the
// newer `SetsView.unit` document.
describe("LiveScoreBody — SetScoreboard's 'Score by {unit}' heading and column labels are localised", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
  const twoSideNames = { home: "Riverside FC", away: "Oakdale United" };
  const dataWithSets = (sets: { home: number; away: number; closed: boolean }[]) => ({
    status: "in_play",
    summary: {
      headline: "1 – 0 (14–11)",
      perSide: [
        { entrantId: "home", line: "1" },
        { entrantId: "away", line: "0" },
      ],
      detail: { sets },
    },
    outcome: null,
  });
  const twoSets = [
    { home: 21, away: 15, closed: true },
    { home: 14, away: 11, closed: false },
  ];

  it("volleyball ('set' unit), rendered with the FRENCH dict: heading and column label read French, not English", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithSets(twoSets)}
        entrantNames={twoSideNames}
        sportKey="volleyball"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain("Score par set");
    expect(html).toContain("Set 1"); // matchCentre.col.set is "Set {n}" in every locale — a genuine cognate
    expect(html).not.toContain("Score by set");
  });

  it("badminton ('game' unit), rendered with the FRENCH dict: heading and column label read French, not English", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithSets(twoSets)}
        entrantNames={twoSideNames}
        sportKey="badminton"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain("Score par jeu");
    expect(html).toContain("Jeu 1");
    expect(html).not.toContain("Score by game");
    expect(html).not.toContain(">game<");
  });

  it("badminton ('game' unit) with no dict prop (the English fallback): heading and column label still read English", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithSets(twoSets)}
        entrantNames={twoSideNames}
        sportKey="badminton"
        decidedTemplates={emptyTemplates}
      />,
    );
    expect(html).toContain("Score by game");
    expect(html).toContain("Game 1");
  });

  // Task 14d — the only existing English-locale coverage of the "set" unit
  // was the negative assertions inside the FRENCH volleyball test above
  // (`not.toContain("Score by set")`), which pins that French doesn't leak
  // English but never pins what English itself renders. `setBreakdown`'s
  // `unit` is now the enum `"set"` (period-surfaces.test.ts), resolved here
  // through `matchCentre.unit.set` ("set", lower-case — mid-sentence in
  // "Score by {unit}") and `matchCentre.col.set` ("Set {n}", sentence case —
  // a column heading) — two separate dictionary keys rather than a runtime
  // capitalise, mirroring the badminton/"game" test just above.
  it("volleyball ('set' unit) with no dict prop (the English fallback): heading reads 'Score by set', column reads 'Set 1'", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={dataWithSets(twoSets)}
        entrantNames={twoSideNames}
        sportKey="volleyball"
        decidedTemplates={emptyTemplates}
      />,
    );
    expect(html).toContain("Score by set");
    expect(html).toContain("Set 1");
  });
});

describe("LiveScoreBody — the full DB status vocabulary, not just the generic 'Not played'", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

  it("'abandoned' renders its OWN word — English 'Abandoned', French 'Abandonné' — never 'Not played'", () => {
    const data = { status: "abandoned", summary: null, outcome: null };
    const htmlEn = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={en as Dict} />,
    );
    expect(htmlEn).toContain("Abandoned");
    expect(htmlEn).not.toContain("Not played");

    const htmlFr = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={fr as Dict} />,
    );
    expect(htmlFr).toContain("Abandonné");
  });

  it("a genuinely UNRECOGNISED status renders ITSELF (the raw word) — never 'Not played', never a dictionary lookup", () => {
    const data = { status: "some_future_status_nobody_mapped_yet", summary: null, outcome: null };
    const html = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={en as Dict} />,
    );
    expect(html).toContain("some_future_status_nobody_mapped_yet");
    expect(html).not.toContain("Not played");
  });
});

// ---------------------------------------------------------------------------
// P6 (whole-branch review) — AN IN-PLAY FIXTURE WITH NOTHING DERIVED YET
// RENDERED A COMPLETELY EMPTY SUMMARY PANEL.
// ---------------------------------------------------------------------------
//
// `suppressScorebug` is passed for every NON-cricket sport (`summary-tab.tsx`),
// so the panel's whole content is the set/period/discipline block below the
// slab. Before a football match's first period event those all render null,
// and `emptyStateKey` was deliberately left null for `in_play` — "the next
// poll fills it" — which produced `<div role="tabpanel">` with NO CHILDREN at
// all in the accessibility tree, on a page a spectator opened to find out what
// is happening. The comment above the ladder describes fixing exactly this for
// the other two statuses.
//
// The copy WAS `matchCentre.empty.beforeStart` — the one existing key that
// made the promise that is TRUE here ("this fills in"), reused rather than
// invented. That reuse was itself a defect: its temporal clause ("…once the
// match starts") rendered beside the court card's LIVE pill and told a
// spectator watching a live match that it had not started. The in-play arm now
// carries `matchCentre.empty.inPlay` in all four locales; the block at the
// bottom of this file pins the copy per locale.
//
// MUTANT KILLED: the `: inPlay ? null` arm restored to the ladder, applied by
// hand and restored from a `cp` backup of the FIXED state (`numTotalTests`
// stayed 534). → RED: exactly one test, "in play with nothing derived: the
// panel carries an empty state, not nothing at all". The other three in this
// block are the pairs that stop a blanket "always render it" fix passing.
describe("LiveScoreBody — suppressScorebug never leaves the panel completely empty (P6)", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
  const twoSideNames = { home: "Riverside FC", away: "Oakdale United" };

  /** Football, kicked off, not one event recorded: no perSide lines, no
   *  periods, no discipline — every secondary block renders null. */
  const inPlayNothingDerived = {
    status: "in_play",
    summary: { headline: "0 – 0" },
    outcome: null,
  };

  const render = (data: unknown, suppress: boolean): string =>
    renderToStaticMarkup(
      <LiveScoreBody
        data={data as never}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
        suppressScorebug={suppress}
      />,
    );

  it("in play with nothing derived: the panel carries an empty state, not nothing at all", () => {
    const html = render(inPlayNothingDerived, true);
    expect(html).toContain('data-testid="mc-summary-empty"');
    // The IN-PLAY sentence, never the not-started one. This panel sits directly
    // beside the court card's LIVE pill, so "…once the match starts" told a
    // spectator watching a live match that the match had not started.
    expect(html).toContain(en["matchCentre.empty.inPlay"] as string);
    expect(html).not.toContain(en["matchCentre.empty.beforeStart"] as string);
    // The defect this replaces was an element with NO text in it whatsoever —
    // pin the rendered COPY, not just the testid, or a fix that emitted an
    // empty <p> would still pass.
    expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
  });

  it("…and the same document with the scorebug NOT suppressed keeps the slab, no empty state", () => {
    // The positive pair. The empty state exists only to replace the suppressed
    // slab; a caller that still paints the slab must not get both.
    const html = render(inPlayNothingDerived, false);
    expect(html).toContain("bg-court");
    expect(html).not.toContain('data-testid="mc-summary-empty"');
  });

  it("…and an in-play document that DOES have a breakdown gets the breakdown, not an empty state", () => {
    // The other half of the pair, and the one that stops a blanket
    // "always render the empty state" mutant passing: the empty state must be
    // conditional on there being nothing else.
    const withPeriods = {
      status: "in_play",
      summary: {
        headline: "2 – 1",
        perSide: [
          { entrantId: "home", line: "2" },
          { entrantId: "away", line: "1" },
        ],
        detail: { periods: [{ phase: "Q1", home: 1, away: 0 }] },
      },
      outcome: null,
    };
    const html = render(withPeriods, true);
    expect(html).toContain(en["matchCentre.goalsByPeriod"] as string);
    expect(html).not.toContain('data-testid="mc-summary-empty"');
  });

  it("the two pre-existing statuses keep their OWN sentences — in play is a fourth arm, not a rewrite", () => {
    const scheduled = render({ status: "scheduled", summary: null, outcome: null }, true);
    expect(scheduled).toContain(en["matchCentre.empty.beforeStart"] as string);
    expect(scheduled).not.toContain(en["matchCentre.empty.inPlay"] as string);
    const decided = render({ status: "decided", summary: null, outcome: null }, true);
    expect(decided).toContain(en["matchCentre.empty.noDetail"] as string);
    expect(decided).not.toContain(en["matchCentre.empty.beforeStart"] as string);
  });

  it("scheduled and in play get DIFFERENT sentences — read off the rendered panel, not the dictionary", () => {
    // The positive pair for the two negative assertions above. Pulling the
    // text out of the panel itself means this fails BOTH ways the fix can
    // rot: the ladder routing both statuses to one arm, and the two keys
    // being given the same sentence in `public.json`.
    const sentence = (html: string): string =>
      html.match(/data-testid="mc-summary-empty"[^>]*>([^<]*)</)?.[1] ?? "";
    const scheduled = sentence(render({ status: "scheduled", summary: null, outcome: null }, true));
    const inPlay = sentence(render(inPlayNothingDerived, true));
    expect(scheduled.length).toBeGreaterThan(0);
    expect(inPlay.length).toBeGreaterThan(0);
    expect(inPlay).not.toEqual(scheduled);
  });
});

// ---------------------------------------------------------------------------
// Accessibility (whole-branch review) — THE NAME CELL IS THE ROW HEADER.
// ---------------------------------------------------------------------------
//
// Both of this file's tables put the entrant name in a plain `<td>`, so a
// screen reader reading "2" out of the Q1 column cannot say whose 2 it is.
// `sets-tab.tsx:164` is the one place on this surface that already got it
// right; these two are the older code it was written against.
//
// MUTANT KILLED: both `<th scope="row">` cells reverted to `<td>`
// (`numTotalTests` stayed 534). → RED: "the goals-by-period table", "the set
// scoreboard".
describe("LiveScoreBody — the entrant name cell is <th scope=\"row\"> in both tables", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
  const twoSideNames = { home: "Riverside FC", away: "Oakdale United" };

  const render = (data: unknown): string =>
    renderToStaticMarkup(
      <LiveScoreBody
        data={data as never}
        entrantNames={twoSideNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={en as Dict}
      />,
    );

  it("the goals-by-period table", () => {
    const html = render({
      status: "in_play",
      summary: {
        headline: "2 – 1",
        perSide: [
          { entrantId: "home", line: "2" },
          { entrantId: "away", line: "1" },
        ],
        detail: { periods: [{ phase: "Q1", home: 1, away: 0 }] },
      },
      outcome: null,
    });
    // BOTH rows — a guard applied to `row === 0` only would pass a one-row probe.
    for (const name of ["Riverside FC", "Oakdale United"]) {
      expect(html, name).toMatch(new RegExp(`<th scope="row"[^>]*>${name}</th>`));
    }
    // The negative half: the name is no longer in a data cell…
    expect(html).not.toMatch(/<td[^>]*>Riverside FC<\/td>/);
    // …and the FIGURES are still `<td>`, or an "everything is a header"
    // mutant passes the assertions above.
    expect(html).toMatch(/<td[^>]*>1<\/td>/);
  });

  it("the set scoreboard", () => {
    const html = render({
      status: "in_play",
      summary: {
        headline: "1 – 0",
        perSide: [
          { entrantId: "home", line: "6" },
          { entrantId: "away", line: "4" },
        ],
        detail: { sets: [{ home: 6, away: 4, closed: true }] },
      },
      outcome: null,
    });
    for (const name of ["Riverside FC", "Oakdale United"]) {
      expect(html, name).toMatch(new RegExp(`<th scope="row"[^>]*>${name}</th>`));
    }
    expect(html).not.toMatch(/<td[^>]*>Riverside FC<\/td>/);
    // Positive pair — the per-set figure cells are still data cells.
    expect(html).toMatch(/<td[^>]*>6<\/td>/);
  });
});

// ---------------------------------------------------------------------------
// `matchCentre.empty.inPlay` — the in-play empty state's own sentence.
// ---------------------------------------------------------------------------
//
// P6 shipped the in-play arm on `matchCentre.empty.beforeStart` ("Live scores
// and highlights appear here once the match starts."), recorded at the time as
// a known copy gap. On a live fixture that sentence renders beside the court
// card's LIVE pill and flatly contradicts it. The arm now has its own key.
//
// A key added to `en` alone renders English to a French spectator with nothing
// in the suite to say so, so the four locales are pinned here as well as the
// wiring.
describe("matchCentre.empty.inPlay — four locales, four real sentences", () => {
  const dicts: Record<string, Record<string, unknown>> = { en, fr, es, nl };

  it("every locale carries the key, and no non-English locale carries the English sentence", () => {
    const english = en["matchCentre.empty.inPlay"] as string;
    expect(english.length).toBeGreaterThan(0);
    for (const [locale, dict] of Object.entries(dicts)) {
      const value = dict["matchCentre.empty.inPlay"];
      expect(typeof value, locale).toBe("string");
      expect((value as string).length, locale).toBeGreaterThan(0);
      if (locale !== "en") expect(value, locale).not.toEqual(english);
    }
  });

  it("each locale's own sentence reaches the panel through t(), never the English one", () => {
    for (const locale of ["fr", "es", "nl"] as const) {
      const html = renderToStaticMarkup(
        <LiveScoreBody
          data={{ status: "in_play", summary: { headline: "0 – 0" }, outcome: null }}
          entrantNames={{ home: "Riverside FC", away: "Oakdale United" }}
          sportKey="football"
          decidedTemplates={{ tie: "", plain: "", shootoutPlain: "", byMethod: {} }}
          dict={dicts[locale] as Dict}
          suppressScorebug
        />,
      );
      expect(html, locale).toContain(dicts[locale]!["matchCentre.empty.inPlay"] as string);
      expect(html, locale).not.toContain(en["matchCentre.empty.inPlay"] as string);
    }
  });
});

// W2a Task 13 (spec §5.5) — the live island's decided sentence carries a chess tie-break's recorded score, read off the
// polled summary's `detail.tiebreak` (`tiebreakScoreFromDetail`), and invents none when the detail has none.
describe("LiveScoreBody — W2a chess tie-break sentence", () => {
  const templates: DecidedOutcomeTemplates = {
    tie: "",
    plain: "{winner} won",
    shootoutPlain: "",
    byMethod: { tiebreak_rapid: "{winner} won on rapid tie-break" },
    tiebreakScored: { rapid: "{winner} won on rapid tie-break ({score})" },
  };
  const names = { home: "Anand Viswanathan", away: "Bela Nakamura" };
  const render = (detail: unknown) =>
    renderToStaticMarkup(
      <LiveScoreBody
        data={{
          status: "decided",
          summary: { headline: "½ — ½", perSide: [{ entrantId: "home", line: "½" }, { entrantId: "away", line: "½" }], detail },
          outcome: { kind: "win", winner: "away", method: "tiebreak_rapid" },
        }}
        entrantNames={names}
        sportKey="boardgame"
        decidedTemplates={templates}
        dict={en as Dict}
      />,
    );

  it("states the recorded score", () => {
    expect(render({ tiebreak: { rung: "rapid", score: "1½–½" } })).toContain("Bela Nakamura won on rapid tie-break (1½–½)");
  });

  it("invents no score when the tie-break recorded none", () => {
    const html = render({ tiebreak: { rung: "rapid" } });
    expect(html).toContain("Bela Nakamura won on rapid tie-break");
    expect(html).not.toContain("(");
  });
});
