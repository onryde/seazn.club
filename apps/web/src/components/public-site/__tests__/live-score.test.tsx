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
