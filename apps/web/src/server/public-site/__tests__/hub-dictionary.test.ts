// Spectator surface W2, Task 6 — the public dictionary keys the competition
// landing page and its sibling public pages (matches hub, table, leaders,
// teams, info, division page, player page, org home/layout/share) use.
//
// Tasks 7-16 consume these keys; nothing renders them yet, which is expected
// and accepted for this task. A key added later is added HERE first.
//
// Two rulings apply, neither derivable from the brief's own draft:
//
// 1. `Object.hasOwn`, not `toHaveProperty`. These dictionaries use FLAT
//    DOTTED KEYS ("landing.status.live.one" is one property, not a nested
//    path); `toHaveProperty("a.b")` path-traverses on the dot and reds on
//    keys that are present while passing on nested objects nobody reads.
//
// 2. Leader-board labels are NOT a `leaders.*` family. `LEADER_SPECS`
//    (./leaders.ts) holds `readonly string[]` per sport, not objects with a
//    `labelKey` — a spread over `.labelKey` would be `undefined` everywhere
//    and a type error besides. Leader labels resolve through
//    `playerStatLabel(sportKey, key, ui, engineLabel)` against
//    `stat.<sport>.<key>` in `ui.json` (see leaders.ts:74-77), where all of
//    them already exist. `leaders.title` and `leaders.empty` (board chrome)
//    stay in the public-dictionary list below; the per-stat labels are
//    covered by the separate `stat.<sport>.<key>` regression test instead.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { LEADER_SPECS } from "../leaders";

export const W2_KEYS = [
  // landing shell
  "landing.tabsLabel", "landing.tab.overview", "landing.tab.matches", "landing.tab.table", "landing.tab.knockout", "landing.tab.stats", "landing.tab.teams", "landing.tab.gallery", "landing.tab.info",
  // One key per RUNG of `landingStatus`'s ladder (`lib/matches-hub.ts:270`):
  // empty → live → next → match_day → finished → dates. `matchDay` was missing
  // from all four locales until PR 2's pre-flight scan for Task 8 found it, and
  // the way it was missed is worth keeping: it was looked for among CONSUMERS,
  // found to have none, and dropped as speculative — while the PRODUCER emits
  // it unconditionally at `matches-hub.ts:330`. A key is owed by what can emit
  // it, never by what happens to read it yet.
  //
  // This list is still hand-written, so it cannot fail when a NEW rung is
  // added. The exhaustive guard belongs at the renderer: Task 11 must switch
  // over `LandingStatus["kind"]` with a `never` default, which makes tsc — not
  // a reviewer — reject a rung with no branch.
  "landing.status.empty", "landing.status.live.one", "landing.status.live.other", "landing.status.next", "landing.status.matchDay", "landing.status.finished", "landing.status.dates", "landing.status.datesFrom",
  // `landing.today` is Task 11's, and it is here for the reason the header
  // above states rather than because someone remembered. The Overview's
  // next-up SCOPE picks the heading as well as the window, so the `match_day`
  // rung emits this key unconditionally — a PRODUCER, exactly like
  // `landing.status.matchDay` — and it arrived in round 2 of Task 11, after
  // this list was last written. Its fr/nl values were asserted by nothing until
  // now, which is the same gap in the same file that let `matchDay` ship
  // missing from four locales.
  "landing.today",
  "landing.liveNow", "landing.nextUp", "landing.tables", "landing.register", "landing.present", "landing.divisions.one", "landing.divisions.other",
  "landing.entrants.one", "landing.entrants.other", "landing.liveCount.one", "landing.liveCount.other", "landing.sponsors", "landing.presentedBy", "landing.partners", "landing.noDivisions",
  // The competition page's `<meta name="description">` fallback (Task 12).
  // `lib/public-meta.ts` used to hardcode the English sentence for all four
  // locales — the competition twin of `division.metaDescription`, which has
  // existed here since Task 6. The helper now takes the resolved fallback and
  // the PAGE resolves it, so this is the only place the sentence lives.
  "landing.metaDescription",
  // matches hub
  "matchesHub.filter.live", "matchesHub.filter.upcoming", "matchesHub.filter.completed", "matchesHub.filtersLabel", "matchesHub.divisionsLabel", "matchesHub.division.all",
  // The called-off statuses. `MatchCard` renders `header.statusLine` for the
  // first time on this branch, and the builder emits exactly these six there
  // (`competition-hub.ts`'s `STATUS_LINE_KEYS`) for abandoned / cancelled /
  // forfeited / postponed / walkover, with `other` as the catch-all.
  //
  // Booked by this file's own rule — "a key is owed by what can EMIT it, never
  // by what happens to read it" — and NOT because a hole was found: all six are
  // present and translated in all four locales today. That is precisely the
  // shape of the `landing.status.matchDay` miss this file documents, which was
  // also fine right up until it was not. Final review C7.
  "matchCentre.status.abandoned", "matchCentre.status.cancelled", "matchCentre.status.forfeited",
  "matchCentre.status.postponed", "matchCentre.status.walkover", "matchCentre.status.other",
  // NO `matchesHub.startsAt`. It was `"{when}"` — byte-identical in all four
  // locales, because a template that is nothing but its own argument cannot
  // differ by locale. A dictionary round trip that returns its input is not a
  // translation, it is a lookup nobody can get wrong or right; and listing it
  // here would have kept it alive forever once merged. It had no consumer:
  // `MatchCard` reads `matchesHub.startsIn` for the relative sentence and
  // `fmtTime` for the clock. Deleted from all four locales with this line.
  "matchesHub.startsIn", "matchesHub.timeTbd", "matchesHub.unscheduled", "matchesHub.empty", "matchesHub.emptyFilter", "matchesHub.live", "matchesHub.ended",
  "matchesHub.round", "matchesHub.timesIn", "matchesHub.card.label",
  // The Knockout tab (plan 2026-09-13, Task 2). Its division chips REUSE
  // `matchesHub.division.all` / `matchesHub.divisionsLabel` above rather than
  // owning a second copy of the same two strings.
  "knockout.champion", "knockout.championLine", "knockout.championLineWalkover", "knockout.roundsLabel", "knockout.liveRound",
  "knockout.next.through", "knockout.next.meets", "knockout.next.meetsWinnerOf", "knockout.next.advances",
  "knockout.view.label", "knockout.view.rounds", "knockout.view.draw", "knockout.drawLabel",
  // A bracket slot still waiting on its feeder (Knockout fix round, D2).
  "knockout.pendingPair", "knockout.pendingLoser",
  // A slot waiting on a match with no pair to name (fix round N1): the feeder's
  // ROUND, as the rail names it, and its place in that round — never the
  // organiser board's "R1·2" short code.
  "knockout.feederWinner", "knockout.feederLoser",
  // The same, when the feeder's round holds ONE match (N1 fix round 1, M2):
  // "Winner of Grand final", never "Winner of Grand final, match 1".
  "knockout.feederWinnerOnly", "knockout.feederLoserOnly",
  // table
  "table.team", "table.col.rank", "table.col.played", "table.col.won", "table.col.drawn", "table.col.lost", "table.col.points", "table.tieBreak", "table.fullDivision", "table.more", "table.fewer", "table.empty", "table.pool", "table.champion",
  // leaders / teams / info (per-stat leader labels live in `stat.<sport>.<key>` in ui.json — see the coverage test below)
  "leaders.title", "leaders.empty",
  "teams.title", "teams.seed", "teams.division", "info.title", "info.dates", "info.venues", "info.registration.open", "info.registration.closed", "info.calendar", "info.share",
  // division page
  "division.tab.schedule", "division.tab.standings", "division.tab.entrants", "division.tabsLabel", "division.champion", "division.resultsGrid", "division.standingsEmpty", "division.entrantsEmpty",
  "division.seed", "division.filter.label", "division.filter.all", "division.filter.allEntrants", "division.view.label", "division.view.day", "division.view.round", "division.calendar", "division.metaDescription", "division.scheduleEmpty",
  // the schedule's zone caption and the division page's kiosk link (N1e e5, e7)
  "division.timesIn", "division.present", "division.filter.showFor",
  // player page
  "player.inThisCompetition", "player.noSquad", "player.stats", "player.matches", "player.matches.empty", "player.line.cricket", "player.line.batting", "player.line.bowling", "player.line.result",
  "player.result.won", "player.result.lost", "player.result.drawn", "player.result.live",
  // org home + layout + share
  "org.live.one", "org.live.other", "layout.tagline", "layout.poweredBy", "share.share", "share.whatsapp", "share.whatsappAria", "share.copy", "share.copied",
  // Task 16 — the /shared leaf surfaces' sweep, one block: `shareLabels`' short
  // WhatsApp label (read by every public ShareBar, and asserted nowhere until
  // now), the QR poster page, the player page's meta description
  // (`lib/public-meta.ts`), the share images' footer tagline and free-tier
  // badge, and the match centre's fallback scorebug (realtime word, serve dot).
  "share.whatsappShort",
  "qrPoster.qrAlt", "qrPoster.scan", "qrPoster.print",
  "player.metaDescription", "og.tagline", "news.card.liveOn",
  "matchCentre.realtime", "matchCentre.serving",
  // Review F2: the division share card's placeholder name and the two lines
  // it draws in place of a table.
  "og.standings.youth", "og.standings.empty", "og.division",
  // format chips
  "format.cricket.overs", "format.minutes", "format.sets.bestOf",
] as const;

describe("W2 public dictionary coverage", () => {
  for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
    it(`${locale} has every W2 key`, () => {
      for (const k of W2_KEYS) expect(Object.hasOwn(dict, k), k).toBe(true);
    });
  }

  it("every {param} in an English template is present in the other three (a dropped {n} renders a raw brace)", () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of W2_KEYS) {
      for (const d of [es, fr, nl]) {
        expect(params((d as Record<string, string>)[k]), k).toEqual(
          params((en as Record<string, string>)[k]),
        );
      }
    }
  });

  it("no key is namespaced with a leading `public.` (the W1 slip)", () => {
    expect(Object.keys(en).filter((k) => k.startsWith("public."))).toEqual([]);
  });

  // The parity test above compares es/fr/nl against EN, so it is blind to a
  // key EN ITSELF authored without the placeholders its caller passes:
  // `[] === []` in all three. `matchesHub.card.label` shipped exactly that —
  // "Match card" / "Ficha del partido" / "Fiche du match" / "Wedstrijdkaart",
  // no `{home}` or `{away}` anywhere — while `MatchCard` passed both names
  // and `interpolate()` discarded them silently. Because that key is the
  // `aria-label` on the card's wrapping `<a>`, and an aria-label REPLACES the
  // element's content for the accessible name, a screen-reader link list over
  // a 40-match hub read "Match card, link" forty times over.
  //
  // This is the anchor side of that pair: what the CALLER passes, declared
  // here, checked against all four locales. The rendered-attribute assertion
  // lives in `match-card.test.tsx`; that one catches EN losing its template,
  // this one catches a translator dropping it from any of the other three.
  // A new entry belongs here the moment a component calls `t()` with vars.
  describe("a key its caller passes vars to declares those vars, in every locale", () => {
    const REQUIRED_PARAMS: Record<string, string[]> = {
      // match-card.tsx — the accessible name, and the meta row's two slots.
      "matchesHub.card.label": ["away", "home"],
      "matchesHub.startsIn": ["when"],
      "matchesHub.round": ["round"],
      // matches-hub chrome (Task 11).
      "matchesHub.timesIn": ["tz"],
      // The competition page's meta description (Task 12) — the page passes
      // both, so a locale that drops one ships a sentence with a hole in it
      // straight into every link preview and search result.
      "landing.metaDescription": ["competition", "org"],
      // knockout-tab.tsx — the champion banner's line and the four "next"
      // sentences under a round's cards. `{round}` is the NEXT round's
      // pre-resolved label; a locale that drops it tells a spectator a winner
      // goes through to nowhere.
      "knockout.championLine": ["name", "round"],
      // The same banner line for a final won by forfeit (fix round 1).
      "knockout.championLineWalkover": ["name", "round"],
      "knockout.next.through": ["name", "round"],
      "knockout.next.meets": ["name", "round"],
      "knockout.next.meetsWinnerOf": ["a", "b", "round"],
      "knockout.next.advances": ["round"],
      // A bracket slot still waiting on its feeder (fix round, D2): the two
      // entrants of the undecided match that feeds it — as a pair in a winner's
      // slot, as "the loser of" in the bronze match's. A locale that drops
      // either name tells a spectator only half of who could be there.
      "knockout.pendingPair": ["a", "b"],
      "knockout.pendingLoser": ["a", "b"],
      // A waiting slot with no pair to name (fix round N1): the builders
      // (`competition-hub.ts`, `match-centre-load.ts`) pass the feeder's round
      // name and its place in that round. A locale that drops `{seq}` names a
      // round of eight matches without saying which.
      "knockout.feederWinner": ["round", "seq"],
      "knockout.feederLoser": ["round", "seq"],
      // A feeder round of one match (M2): the round name alone. A locale that
      // drops `{round}` says "Winner of" and stops.
      "knockout.feederWinnerOnly": ["round"],
      "knockout.feederLoserOnly": ["round"],
      // Task 16. The QR poster's alt names the URL it encodes; the player
      // page's description names both; the share-image badge names the brand
      // (passed, so no translator retypes it).
      "qrPoster.qrAlt": ["url"],
      "player.metaDescription": ["competition", "player"],
      "news.card.liveOn": ["brand"],
      "og.standings.youth": ["brand"],
      "og.standings.empty": ["brand"],
    };
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    it("every key named here is a real W2 key (a typo would make this whole sweep vacuous)", () => {
      for (const k of Object.keys(REQUIRED_PARAMS)) {
        expect((W2_KEYS as readonly string[]).includes(k), k).toBe(true);
      }
    });

    for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
      it(`${locale} carries every declared placeholder`, () => {
        for (const [k, wanted] of Object.entries(REQUIRED_PARAMS)) {
          expect(params((dict as Record<string, string>)[k] ?? ""), `${locale} ${k}`).toEqual(wanted);
        }
      });
    }
  });
});

// Regression guard for `LEADER_SPECS` (./leaders.ts): every sport/stat pair it
// declares must resolve to a real `stat.<sport>.<key>` entry in `ui.json`, in
// all four locales — the family `playerStatLabel` actually reads. Derived
// from `LEADER_SPECS` itself, never a table typed into the test, so a change
// to the engine specs moves this test with it. This is the only thing
// standing between a new leader board and an English fallback in es/fr/nl.
describe("leader board stat labels exist in ui.json for every locale", () => {
  const pairs = Object.entries(LEADER_SPECS).flatMap(([sport, stats]) =>
    stats.map((stat) => ({ sport, stat, key: `stat.${sport}.${stat}` })),
  );

  it("LEADER_SPECS is non-empty (a vacuous sweep proves nothing)", () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  for (const [locale, ui] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl })) {
    it(`${locale} ui.json has a stat label for every LEADER_SPECS entry`, () => {
      for (const { key } of pairs) expect(Object.hasOwn(ui, key), key).toBe(true);
    });
  }
});

// Two keys now live in BOTH dictionaries. That is deliberate: Task 16 creates
// `components/public-site/share-labels.ts` so the public pages feed `ShareBar`
// from the PUBLIC dict, while `components/share-button.tsx` keeps reading
// `ui.json` through `useMsg()` for console surfaces. Both namespaces stay
// live, so neither copy can simply be deleted.
//
// But two sources for one string is how translations drift apart, and these
// two are the same words for the same action — "WhatsApp" is a proper noun,
// and "Link copied" is one toast, not two. A translator who edits one file
// and not the other must red here rather than ship a surface that says one
// thing on the console and another on the public page.
describe("the share keys that live in both dictionaries stay identical", () => {
  const SHARED = ["share.whatsapp", "share.copied"] as const;

  for (const [locale, [pub, ui]] of Object.entries({
    en: [en, uiEn],
    es: [es, uiEs],
    fr: [fr, uiFr],
    nl: [nl, uiNl],
  })) {
    it(`${locale} reads the same in public.json and ui.json`, () => {
      for (const k of SHARED) {
        expect((ui as Record<string, string>)[k], `${locale} ${k}`).toBe(
          (pub as Record<string, string>)[k],
        );
      }
    });
  }
});

// The SAME story for the round label, found later and by a different route.
//
// `MatchCard` falls back to `matchesHub.round` when the hub document arrives
// without a resolved `roundLabel`. The builder resolves that label through
// `roundRoleLabel`, whose `plain_round` arm reads `bracket.round.plain` in
// ui.json — so a spectator can meet the same round, phrased twice, depending
// only on whether the fixture's stage row was reachable. They must agree.
//
// The placeholder NAMES differ by accident of history (`{n}` in the older key,
// `{round}` in the newer), so the comparison normalises the placeholder rather
// than the sentence. Comparing raw strings would red on a difference nobody
// can see, which is how a guard gets deleted instead of fixed.
describe("the round label reads the same whether the builder or the card supplies it", () => {
  const norm = (s: string) => s.replace(/\{\w+\}/g, "{}");

  for (const [locale, [pub, ui]] of Object.entries({
    en: [en, uiEn],
    es: [es, uiEs],
    fr: [fr, uiFr],
    nl: [nl, uiNl],
  })) {
    it(`${locale}: matchesHub.round matches bracket.round.plain`, () => {
      const card = (pub as Record<string, string>)["matchesHub.round"];
      const builder = (ui as Record<string, string>)["bracket.round.plain"];
      expect(card, `${locale} matchesHub.round missing`).toBeTruthy();
      expect(builder, `${locale} bracket.round.plain missing`).toBeTruthy();
      expect(norm(card), `${locale} round label`).toBe(norm(builder));
    });
  }

  // A THIRD place the same noun appears, and the one that was drifting. The
  // division page's view switcher ("group by round") sits on the SAME page as
  // the round labels themselves, so a spectator reads both at once — and fr
  // said "Par ronde" against "Tour {round}" everywhere else, two different
  // French words for one thing, three lines apart. Commit f996c155f settled
  // the noun per locale when it moved `matchesHub.round` onto `Tour` to agree
  // with `bracket.round.plain`; this test is what keeps the switcher on that
  // decision instead of leaving it to be found by eye again.
  //
  // Derived from `matchesHub.round` itself, never a table of nouns typed in
  // here: whichever word a locale settles on, the switcher has to use it.
  for (const [locale, pub] of Object.entries({ en, es, fr, nl })) {
    it(`${locale}: division.view.round names the SAME round noun`, () => {
      const dict = pub as Record<string, string>;
      const noun = dict["matchesHub.round"]!.replace(/\{\w+\}/g, "").trim().toLowerCase();
      expect(noun.length, `${locale} round noun`).toBeGreaterThan(2);
      expect(dict["division.view.round"]!.toLowerCase(), `${locale} view switcher`).toContain(noun);
    });
  }
});

// N1 fix round 1, M1 — a feeder slot's sentence reads naturally in es/fr/nl.
//
// `{round}` is a capitalised round name ("Cuartos de final", "Quarts de
// finale", "Kwartfinales") that wants an article mid-sentence, so "Ganador de
// Cuartos de final, partido 2" reads as a machine wrote it. nl writes
// "de {round}", as its `knockout.next.*` sentences do; es and fr avoid the
// article with a colon.
//
// N1c (review-n1f m2) — the ROLE word comes first in every locale. M1 had es
// and fr put the round first and the role last ("… match 1 : vainqueur"), and a
// waiting side's name sits in a `truncate` box: on a 320px losers'-round card
// the ellipsis ate "vainqueur"/"perdant", the one word that says which result
// fills the slot. So the text before `{round}` must already name the role, and
// name it differently for a winner and a loser. Read out of each dictionary,
// never a table of words typed in here.
describe("feeder-slot phrases name the role BEFORE the round, in every locale (N1c m2)", () => {
  const FEEDER = [
    "knockout.feederWinner",
    "knockout.feederLoser",
    "knockout.feederWinnerOnly",
    "knockout.feederLoserOnly",
  ] as const;
  /** Everything a phrase says before its round name. */
  const lead = (dict: Record<string, string>, k: (typeof FEEDER)[number]) => {
    const at = dict[k]!.indexOf("{round}");
    expect(at, `${k} has a {round}: ${dict[k]}`).toBeGreaterThanOrEqual(0);
    return dict[k]!.slice(0, at);
  };

  for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, string>][]) {
    it(`${locale}: each phrase opens with its role word, the winner's differs from the loser's, and "Only" keeps the same opening`, () => {
      for (const k of FEEDER) expect(lead(dict, k).trim(), `${k}: ${dict[k]}`).not.toBe("");
      expect(lead(dict, "knockout.feederWinner"), `${locale} winner vs loser opening`).not.toBe(
        lead(dict, "knockout.feederLoser"),
      );
      expect(lead(dict, "knockout.feederWinnerOnly"), `${locale} winner opening`).toBe(lead(dict, "knockout.feederWinner"));
      expect(lead(dict, "knockout.feederLoserOnly"), `${locale} loser opening`).toBe(lead(dict, "knockout.feederLoser"));
    });

    // N1d d1 (review-n1c m1) — "the winner's opening differs from the loser's"
    // is just as true of a SWAPPED pair: "Perdant : {round}" on the winner key
    // still differs from "Vainqueur : {round}" on the loser key, and a fr
    // bracket would then tell spectators the semi's LOSER plays the final. So
    // the role word itself is pinned, against the word each dictionary already
    // uses for that role in an unrelated sentence: `matchCentre.winner`
    // ("Winner:") and `knockout.pendingLoser` ("Loser of {a} v {b}"). Nothing
    // typed in here: a locale that renames its winner renames it in both places.
    it(`${locale}: the winner phrases open with the dictionary's own word for a winner, the loser phrases with its word for a loser`, () => {
      const firstWord = (s: string) => /^\p{L}+/u.exec(s.trim())?.[0] ?? "";
      const winnerWord = firstWord(dict["matchCentre.winner"]!);
      const loserWord = firstWord(dict["knockout.pendingLoser"]!);
      expect(winnerWord, `${locale} matchCentre.winner: ${dict["matchCentre.winner"]}`).not.toBe("");
      expect(loserWord, `${locale} knockout.pendingLoser: ${dict["knockout.pendingLoser"]}`).not.toBe("");
      expect(winnerWord, `${locale}: the two role words must differ to witness a swap`).not.toBe(loserWord);
      for (const k of ["knockout.feederWinner", "knockout.feederWinnerOnly"] as const) {
        expect(firstWord(lead(dict, k)), `${locale} ${k}: ${dict[k]}`).toBe(winnerWord);
      }
      for (const k of ["knockout.feederLoser", "knockout.feederLoserOnly"] as const) {
        expect(firstWord(lead(dict, k)), `${locale} ${k}: ${dict[k]}`).toBe(loserWord);
      }
    });
  }

  it("nl gives the round its article, 'van de {round}', the way its knockout.next.* sentences say 'de {round}'", () => {
    const dict = nl as Record<string, string>;
    expect(dict["knockout.next.advances"]).toContain("de {round}");
    for (const k of FEEDER) expect(dict[k], k).toContain("van de {round}");
  });
});
