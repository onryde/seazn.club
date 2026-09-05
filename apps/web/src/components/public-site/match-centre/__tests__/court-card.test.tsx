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
});
