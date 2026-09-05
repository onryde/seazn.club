// Spectator surface W1, Task 10 — CourtCard static-markup tests. This
// workspace's vitest runs `environment: "node"` (no jsdom); `renderToStaticMarkup`
// is real React SSR and needs no DOM, so a plain function component with
// `useState`-free rendering (CourtCard has no hooks at all) renders correctly
// through it. Assertions anchor on `="` per rule 5 of the Task 10 dispatch —
// an omitted prop serialises as `"$undefined"` in React's own output, so a
// bare substring probe on the attribute NAME alone can pass in both states.
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

describe("CourtCard", () => {
  it("live: LIVE pill, both score lines, the chase line and the rate line", () => {
    const html = renderToStaticMarkup(<CourtCard header={liveHeader} dict={dict} updatedAt={Date.now()} />);
    expect(html).toContain('data-testid="mc-live-pill"');
    expect(html).not.toContain('data-testid="mc-result-chip"'); // positive pair of the negative below
    expect(html).toContain('data-testid="mc-score-0"');
    expect(html).toContain('data-testid="mc-score-1"');
    expect(html).toContain("56/6");
    expect(html).toContain('data-testid="mc-status-line"');
    expect(html).toContain("Competitions run by Riverside");
    expect(html).toContain('data-testid="mc-rate-line"');
    expect(html).toContain("CRR 7.00");
  });

  it("final: result chip, no rate line", () => {
    const html = renderToStaticMarkup(<CourtCard header={decidedHeader} dict={dict} updatedAt={Date.now()} />);
    expect(html).toContain('data-testid="mc-result-chip"');
    expect(html).not.toContain('data-testid="mc-live-pill"'); // positive pair of the negative above
    expect(html).not.toContain('data-testid="mc-rate-line"');
    expect(html).toContain("156/6");
    expect(html).toContain("120/9");
  });
});
