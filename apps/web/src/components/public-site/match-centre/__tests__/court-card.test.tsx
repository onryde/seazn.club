// Spectator surface W1, Task 10 — CourtCard static-markup tests. This
// workspace's vitest runs `environment: "node"` (no jsdom); `renderToStaticMarkup`
// is real React SSR, and CourtCard's only hook (`useNow`) is effect-driven —
// SSR never runs effects, so the INITIAL value from its `useState` lazy
// initializer (a real `Date.now()`) is what these tests see; no fake timers
// needed for wiring, only for `useNow`'s own ticking (see use-now.test.ts).
// Assertions anchor on `="` per rule 5 of the Task 10 dispatch — an omitted
// prop serialises as `"$undefined"` in React's own output, so a bare
// substring probe on the attribute NAME alone can pass in both states.
//
// Review fix round 1 (CRITICAL 1, IMPORTANT 4, IMPORTANT 5): every test now
// also asserts the RENDERED COPY a spectator actually reads (not just a
// testid's presence) — this is exactly the class of defect the "public."
// key-prefix bug shipped past (every testid assertion here stayed green
// while every string rendered as a raw, untranslated key). Adds coverage
// for `in_play` and `other` (previously collapsed into "Scheduled"), and for
// the freshness line now deriving from `header.updatedAt` (ticked by
// `useNow`) rather than a separate `updatedAt` prop (removed).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import { CourtCard } from "../court-card";

const dict = en as Dict;

const liveHeader: MatchCentreHeaderT = {
  live: true,
  status: "in_play",
  sides: [
    { entrantId: "home", name: "Riverside", short: "RVS", colour: null, badgeUrl: null },
    { entrantId: "away", name: "Oakdale", short: "OAK", colour: null, badgeUrl: null },
  ],
  scoreLines: ["56/6", "—"],
  subLines: ["(8.0 ov)", null],
  battingIndex: 0,
  // Real dictionary key + params, resolved client-side via t() — proves the
  // Msg → text pipeline, not just that SOME string appears.
  statusLine: { key: "org.competitionsBy", params: { org: "Riverside" } },
  rateLine: "CRR 7.00 · RRR 9.71",
  phase: null,
  strength: null,
  pillNote: null,
  metaLine: null,
  updatedAt: new Date().toISOString(),
};

const decidedHeader: MatchCentreHeaderT = {
  ...liveHeader,
  live: false,
  status: "decided",
  scoreLines: ["156/6", "120/9"],
  subLines: [null, null],
  battingIndex: null,
  rateLine: null,
};

const scheduledHeader: MatchCentreHeaderT = {
  ...liveHeader,
  live: false,
  status: "scheduled",
  statusLine: { key: "org.competitionsBy", params: { org: "Saturday 14:00" } },
  rateLine: null,
};

const otherHeader: MatchCentreHeaderT = {
  ...liveHeader,
  live: false,
  status: "other",
  statusLine: { key: "org.competitionsBy", params: { org: "Abandoned — rain" } },
  rateLine: null,
};

describe("CourtCard", () => {
  it("in_play: LIVE pill with the real word 'Live' rendered, both score lines, the chase line and the rate line", () => {
    const html = renderToStaticMarkup(<CourtCard header={liveHeader} dict={dict} />);
    expect(html).toContain('data-testid="mc-live-pill"');
    expect(html).toContain(">Live<"); // RENDERED COPY, not just the testid
    expect(html).not.toContain('data-testid="mc-result-chip"'); // positive pair of the negative below
    expect(html).toContain('data-testid="mc-score-0"');
    expect(html).toContain('data-testid="mc-score-1"');
    expect(html).toContain("56/6");
    expect(html).toContain('data-testid="mc-status-line"');
    expect(html).toContain("Competitions run by Riverside");
    expect(html).toContain('data-testid="mc-rate-line"');
    expect(html).toContain("CRR 7.00");
  });

  it("decided: result chip reading 'Ended', no rate line", () => {
    const html = renderToStaticMarkup(<CourtCard header={decidedHeader} dict={dict} />);
    expect(html).toContain('data-testid="mc-result-chip"');
    expect(html).toContain(">Ended<"); // RENDERED COPY
    expect(html).not.toContain('data-testid="mc-live-pill"'); // positive pair of the negative above
    expect(html).not.toContain('data-testid="mc-rate-line"');
    expect(html).toContain("156/6");
    expect(html).toContain("120/9");
  });

  it("scheduled: result chip reading 'Scheduled', distinct from decided's 'Ended'", () => {
    const html = renderToStaticMarkup(<CourtCard header={scheduledHeader} dict={dict} />);
    expect(html).toContain('data-testid="mc-result-chip"');
    expect(html).toContain(">Scheduled<");
    expect(html).not.toContain(">Ended<");
    expect(html).not.toContain('data-testid="mc-live-pill"');
  });

  it("other (postponed/abandoned/walkover/cancelled): NO chip at all, but statusLine still renders the reason", () => {
    const html = renderToStaticMarkup(<CourtCard header={otherHeader} dict={dict} />);
    expect(html).not.toContain('data-testid="mc-live-pill"');
    expect(html).not.toContain('data-testid="mc-result-chip"');
    expect(html).toContain('data-testid="mc-status-line"');
    expect(html).toContain("Competitions run by Abandoned — rain");
  });

  it("the live pill's dot only pulses when header.live is true, even while in_play", () => {
    const pausedInPlay: MatchCentreHeaderT = { ...liveHeader, live: false };
    const html = renderToStaticMarkup(<CourtCard header={pausedInPlay} dict={dict} />);
    expect(html).toContain('data-testid="mc-live-pill"'); // still the LIVE pill — status drives the chip, not `live`
    expect(html).not.toContain("animate-live-pulse");
  });

  it("derives the freshness line from header.updatedAt (ticked by useNow), not a separate prop", () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const header: MatchCentreHeaderT = { ...liveHeader, updatedAt: fiveSecondsAgo };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).toContain('data-testid="mc-updated-at"');
    expect(html).toContain("Updated 5s ago");
  });

  // Defect round 15b — axe measured `mc-updated-at` at 4.09:1 on `bg-court`
  // (walkthrough evidence), short of WCAG AA's 4.5:1: an extra `/70` opacity
  // was stacked on top of `text-court-muted`'s own embedded alpha. This
  // workspace has no jsdom, so contrast itself can't be computed here (the
  // e2e `axe: …` test in spectator-public-2.spec.ts measures the real
  // ratio) — this pins the CLASS the fix depends on: no opacity modifier on
  // `text-court-muted`, the same unmodified token `mc-status-line` and
  // `mc-rate-line` already use above (neither flagged by axe).
  it("mc-updated-at uses the unmodified text-court-muted token — no stacked opacity modifier", () => {
    const header: MatchCentreHeaderT = { ...liveHeader, updatedAt: new Date().toISOString() };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    const updatedAtClass = html.match(/data-testid="mc-updated-at" class="([^"]*)"/)?.[1];
    expect(updatedAtClass).toBeTruthy();
    expect(updatedAtClass).toMatch(/(^|\s)text-court-muted(\s|$)/);
    expect(updatedAtClass).not.toContain("text-court-muted/");
  });

  // Review fix round 2 (Task 10 deferred minor) — the freshness line is a
  // "how stale is the LIVE score" signal; a decided/scheduled/other page's
  // `updatedAt` is just whenever the document was last built, so showing it
  // there could read something absurd ("Updated 47231s ago" on a page that
  // finished hours ago). It's positive pair is the in_play test above.
  it("the freshness line renders ONLY while in_play — absent for decided, scheduled, and other", () => {
    for (const header of [decidedHeader, scheduledHeader, otherHeader]) {
      const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
      expect(html).not.toContain('data-testid="mc-updated-at"');
    }
  });

  // Review fix round 2 (Task 10 deferred minor) — a malformed/unparsable
  // `header.updatedAt` must read "0s ago", never the `NaN` a bare
  // `Math.floor(NaN / 1000)` would otherwise produce.
  it("a malformed header.updatedAt reads '0s ago' rather than NaN", () => {
    const header: MatchCentreHeaderT = { ...liveHeader, updatedAt: "not-a-real-date" };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).toContain("Updated 0s ago");
    expect(html).not.toContain("NaN");
  });

  // -------------------------------------------------------------------------
  // The period kernel's live pair — restored after CI found both had been lost
  // -------------------------------------------------------------------------
  //
  // `v6-sports.spec.ts` was the only test covering either, it lives in a
  // Playwright project no local gate runs, and e2e only fires on pushes to
  // main — so W1 dropped the power-play chip and the live phase from the
  // public page and every local run stayed green. These are the unit tests
  // that would have caught it.

  it("renders the live phase, resolved through term.* rather than as the engine's raw token", () => {
    const header: MatchCentreHeaderT = { ...liveHeader, phase: "P1" };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).toContain('data-testid="mc-phase"');
    // The dictionary's own value, never a literal typed here — re-wording
    // `term.P1` moves this assertion with it.
    expect(html).toContain(dict["term.P1"] as string);
    // ...and NOT the raw token, which is what the old scorebug showed and
    // what a `t()`-less render would leave behind.
    expect(html).not.toContain(">P1<");
  });

  it("falls back to the raw phase token when the dictionary does not name it", () => {
    // An unbounded phase the authored set does not cover. `t()` would warn and
    // return "term.OT9", printing a dictionary key on a public page.
    const header: MatchCentreHeaderT = { ...liveHeader, phase: "OT9" };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).toContain("OT9");
    expect(html).not.toContain("term.OT9");
  });

  it("renders the power-play strength chip verbatim — a number pair, not copy", () => {
    const header: MatchCentreHeaderT = { ...liveHeader, strength: "5v4" };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).toContain('data-testid="mc-strength"');
    expect(html).toContain("5v4");
  });

  // The negative pair for both, and the reason the builder gates them on
  // in_play: a match with neither must render neither element, not an empty
  // chip. Asserting only the presence cases above would pass just as happily
  // if the component rendered a blank span whenever the fields were null.
  it("renders NEITHER element when the header carries neither fact", () => {
    const html = renderToStaticMarkup(<CourtCard header={liveHeader} dict={dict} />);
    expect(html).not.toContain('data-testid="mc-phase"');
    expect(html).not.toContain('data-testid="mc-strength"');
  });

  // Both live on the LIVE pill's row, which only renders while in play — so a
  // decided header cannot show a stale phase or a stale power play even if
  // the document carried one. This pins the placement, not just the presence.
  it("shows neither on a DECIDED header, even when both fields are populated", () => {
    const header: MatchCentreHeaderT = { ...decidedHeader, phase: "P3", strength: "5v4" };
    const html = renderToStaticMarkup(<CourtCard header={header} dict={dict} />);
    expect(html).not.toContain('data-testid="mc-phase"');
    expect(html).not.toContain('data-testid="mc-strength"');
  });
});

// ---------------------------------------------------------------------------
// The truncate chain on the entrant-name span — streaming T1's D4 fix, and the
// only production change on that branch (`court-card.tsx`: a `min-w-0` beside
// the existing `truncate`). Until this block its ONLY regression witness was
// the visual gate's `truncate-chain` check, and `.github/workflows/e2e.yml`
// triggers on push to `main`, never on a pull request — so the change was
// covered AFTER merge, not before. This closes that.
//
// Same node-env idiom as the rest of this file and `phone-disclosure.test.tsx`:
// `renderToStaticMarkup` is real React SSR, so these assertions read the class
// list that actually reaches the browser rather than the source text. There is
// no jsdom here and jsdom does no layout anyway — the 320px paint stays the
// visual gate's job. What this pins is the class contract that produces it, so
// a later edit cannot silently drop the `min-w-0` again.
// ---------------------------------------------------------------------------

/** The whole `<div>…</div>` of the score row that carries `name`. */
function nameRow(html: string, name: string): string {
  const at = html.indexOf(`>${name}<`);
  expect(at, `"${name}" is not rendered in the card`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div class="flex items-baseline', at);
  expect(open, "no row flex opens before the name").toBeGreaterThan(-1);
  const close = html.indexOf("</div>", at);
  expect(close, "the row never closes").toBeGreaterThan(-1);
  return html.slice(open, close + "</div>".length);
}

/**
 * The class list of the span that actually HOLDS the name.
 *
 * It used to take the row's first span, which stopped being the name span the
 * moment the crest tile arrived and the name was wrapped in a flex — and the
 * failure read as "truncate is missing" on a card that truncates correctly.
 * Anchoring on the name's own text finds the right span whatever wraps it.
 */
function nameSpanClasses(row: string, name: string): string {
  const at = row.indexOf(`>${name}<`);
  expect(at, `"${name}" is not in this row`).toBeGreaterThan(-1);
  const open = row.lastIndexOf("<span ", at);
  expect(open, "the name is in no span").toBeGreaterThan(-1);
  const m = /<span class="([^"]*)"/.exec(row.slice(open));
  expect(m, "the name's span carries no class list").not.toBeNull();
  return m![1]!;
}

/** `\bmin-w-0\b` also matches inside `max-md:min-w-0` (`-` to `m` is a word
 *  boundary in JS regex), and a phone-only variant would leave the desktop row
 *  exactly as broken as it was. Anchored on real class-list separators so a
 *  variant-prefixed utility cannot satisfy these assertions. */
const utility = (name: string) => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`);

describe("CourtCard — the live pill's note and the meta line", () => {
  // The design board's court card opens `LIVE · 12.3 OV` with
  // `8-over match · Round 1 · Garon Park` beside it. Neither had a source on
  // `MatchCentreHeader` — the format label, the round and the venue all reach
  // the builder for the Info tab's rows, and the header simply never carried
  // them; the over lives on the innings card.
  const withBoth: MatchCentreHeaderT = {
    ...liveHeader,
    pillNote: { key: "matchCentre.oversShort", params: { overs: "12.3" } },
    metaLine: "8-over match · Round 1 · Garon Park",
  };

  it("renders the over INSIDE the live pill, resolved through the dictionary", () => {
    const html = renderToStaticMarkup(<CourtCard header={withBoth} dict={dict} />);
    expect(html).toContain('data-testid="mc-pill-note"');
    // The RENDERED copy, not the key: `pillNote` is a Msg because the unit is
    // translated, so a raw "matchCentre.oversShort" on the page is exactly the
    // failure this asserts against.
    expect(html).toContain("12.3 ov");
    expect(html).not.toContain("matchCentre.oversShort");
    // INSIDE the pill, not merely somewhere on the card — the board puts it
    // after the status word, and a note floating elsewhere would satisfy a
    // bare `toContain`.
    const pill = html.slice(html.indexOf('data-testid="mc-live-pill"'));
    expect(pill.slice(0, pill.indexOf("</p>"))).toContain("12.3 ov");
  });

  it("renders the meta line, and omits it entirely when there is none", () => {
    const html = renderToStaticMarkup(<CourtCard header={withBoth} dict={dict} />);
    expect(html).toContain('data-testid="mc-meta-line"');
    expect(html).toContain("8-over match · Round 1 · Garon Park");

    // The positive pair. `liveHeader` carries neither field, so this is the
    // same card with the same status proving the two lines are driven by the
    // DATA rather than by the status.
    const bare = renderToStaticMarkup(<CourtCard header={liveHeader} dict={dict} />);
    expect(bare).not.toContain('data-testid="mc-meta-line"');
    expect(bare).not.toContain('data-testid="mc-pill-note"');
    expect(bare).toContain('data-testid="mc-live-pill"');
  });

  it("drops both the moment the match is not in play", () => {
    // A finished match is not anywhere: there is no current over, and the pill
    // is a result chip rather than a live pill. Without this the note would
    // survive into a decided page carrying the last over played.
    const done: MatchCentreHeaderT = { ...withBoth, live: false, status: "decided" };
    const html = renderToStaticMarkup(<CourtCard header={done} dict={dict} />);
    expect(html).not.toContain('data-testid="mc-pill-note"');
    // The meta line is NOT gated on in_play — a finished match was still an
    // 8-over match at Garon Park, and that is the half a spectator arriving at
    // a result page wants.
    expect(html).toContain('data-testid="mc-meta-line"');
  });
});

describe("CourtCard — the crest tile and the side's own colour", () => {
  // `Side.colour` and `Side.badgeUrl` have been on the wire since W1
  // (`match-centre-schema.ts:11`, populated from `colors.home_primary` at
  // `match-centre-load.ts:207`) and this card read NEITHER — an inert seam, and
  // the SECOND time this same seam has been found (`entity-logo.tsx`'s header
  // records it being fixed for match cards and not here). The design board's
  // court card is crest tiles in team colours, so this is what makes the board
  // reachable at all.
  const coloured: MatchCentreHeaderT = {
    ...liveHeader,
    sides: [
      { entrantId: "home", name: "Southend Blue Blazers", short: "SBB", colour: "#2563eb", badgeUrl: null },
      { entrantId: "away", name: "Southend Queens", short: "SQ", colour: null, badgeUrl: null },
    ],
  };

  it("paints the tile in the side's colour, and leaves a colourless side neutral", () => {
    const html = renderToStaticMarkup(<CourtCard header={coloured} dict={dict} />);
    // The colour reaches the STYLE, which is the only thing that paints. A
    // class-token scan would pass on a card that carried the value and never
    // used it — which is exactly the state this test exists to end.
    expect(html).toContain("background:#2563eb");
    // The negative pair, and it is the half that proves the colour came from
    // the side rather than from a constant: the away side has none, so exactly
    // ONE tile is painted.
    expect(html.match(/background:#2563eb/g)?.length).toBe(1);
  });

  it("renders a tile for BOTH sides — a colourless side still gets its monogram", () => {
    const html = renderToStaticMarkup(<CourtCard header={coloured} dict={dict} />);
    // Two initials-tiles, one per side. Without this a card could paint the
    // home tile and silently drop the away one and the test above would pass.
    expect(html).toContain(">SB<");
    expect(html).toContain(">SQ<");
  });

  it("leads with the FULL name, not the short code", () => {
    const html = renderToStaticMarkup(<CourtCard header={coloured} dict={dict} />);
    expect(html).toContain("Southend Blue Blazers");
    // `short` is still on the wire — this asserts what the card LEADS with, so
    // it must not claim the short code was deleted.
    expect(html).not.toMatch(/>SBB</);
  });
});

describe("CourtCard — a long entrant name ellipses instead of pushing the score off its row", () => {
  // `short` is EMPTY on both sides on purpose (the schema types it `z.string()`,
  // never nullable, so "" is how a side without a short code arrives).
  // `{side.name || side.short}` means the full name is what renders whenever
  // there is one, which is why a realistic name is what reaches the overflow
  // threshold — this sat latent while the card led with three-letter codes.
  const longHeader: MatchCentreHeaderT = {
    ...liveHeader,
    sides: [
      { entrantId: "home", name: "Riverside Wanderers Athletic Club", short: "", colour: null, badgeUrl: null },
      { entrantId: "away", name: "Oakdale Community Sports Association", short: "", colour: null, badgeUrl: null },
    ],
  };

  it("the name span carries min-w-0 beside its truncate, in a row flex whose other item is shrink-0", () => {
    const html = renderToStaticMarkup(<CourtCard header={longHeader} dict={dict} />);
    const row = nameRow(html, "Riverside Wanderers Athletic Club");
    // The parent is what makes `min-w-0` necessary rather than decorative: an
    // item of a row flex takes `min-width: auto` (css-flexbox-1 §4.5), which
    // refuses to shrink it below its content — so `truncate` never engages and
    // the name pushes its sibling out of the row instead of ellipsing.
    expect(row.startsWith('<div class="flex items-baseline justify-between gap-3 tabular-nums')).toBe(true);
    const classes = nameSpanClasses(row, "Riverside Wanderers Athletic Club");
    expect(classes, "the flex item cannot shrink below its content without min-w-0").toMatch(utility("min-w-0"));
    expect(classes, "min-w-0 only matters because this span truncates").toMatch(utility("truncate"));
    // The sibling that wins the row when the name will not shrink — the score,
    // i.e. the one thing on this card a spectator came for.
    expect(row).toContain('<span class="shrink-0 text-right">');
    expect(row).toContain('data-testid="mc-score-0"');
  });

  it("carries it on BOTH sides' rows, not just the batting one — the class list is rebuilt per row", () => {
    const html = renderToStaticMarkup(<CourtCard header={longHeader} dict={dict} />);
    // `battingIndex: 0` appends `font-bold` to the home row only, so the two
    // rows are not the same string; one sample is not a parity sweep.
    const away = nameRow(html, "Oakdale Community Sports Association");
    expect(away.startsWith('<div class="flex items-baseline justify-between gap-3 tabular-nums')).toBe(true);
    const classes = nameSpanClasses(away, "Oakdale Community Sports Association");
    expect(classes).toMatch(utility("min-w-0"));
    expect(classes).toMatch(utility("truncate"));
    expect(away).toContain('data-testid="mc-score-1"');
  });
});
