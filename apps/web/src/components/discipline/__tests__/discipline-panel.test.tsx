import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/",
}));

import { DisciplinePanel } from "@/components/discipline/discipline-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { Suspension } from "@/server/usecases/discipline";

const dict = uiEn as unknown as Dict;

function sus(over: Partial<Suspension>): Suspension {
  return {
    id: "s1",
    divisionId: "d1",
    personId: "p1",
    personName: "J. Smith",
    entrantId: "e1",
    entrantName: "Rovers",
    status: "pending",
    source: "auto_dismissal",
    reason: "Red card",
    matchesTotal: 2,
    matchesServed: 0,
    fixtureId: null,
    createdAt: "2026-07-18T00:00:00Z",
    decidedAt: null,
    triggerVoided: false,
    coveredMatches: [],
    ...over,
  };
}

function render(items: Suspension[], tz = "Europe/London", locale: "en" | "fr" = "en", d: Dict = dict): string {
  return renderToStaticMarkup(
    <DictProvider dict={d} locale={locale}>
      <DisciplinePanel
        divisionId="d1"
        initial={items}
        squad={[{ person_id: "p9", full_name: "K. Doe" }]}
        canEdit
        tz={tz}
      />
    </DictProvider>,
  );
}

describe("DisciplinePanel", () => {
  it("shows a pending row with confirm + waive and the person's name", () => {
    const html = render([sus({ id: "s1", status: "pending" })]);
    expect(html).toContain("J. Smith");
    expect(html).toContain("Confirm");
    expect(html).toContain("Waive");
    expect(html).toContain('data-testid="pending-row"');
  });

  it("renders the trigger-voided hint chip when the trigger card was voided", () => {
    const html = render([sus({ status: "pending", triggerVoided: true })]);
    expect(html).toContain("trigger card was voided");
  });

  it("shows served pips on an active ban", () => {
    const html = render([sus({ id: "a1", status: "active", matchesServed: 1, matchesTotal: 2 })]);
    expect(html).toContain('data-testid="active-row"');
    expect(html).toContain("1 of 2 matches served");
  });

  it("collects served/waived rows into the history disclosure", () => {
    const html = render([
      sus({ id: "h1", status: "served" }),
      sus({ id: "h2", status: "waived" }),
    ]);
    expect(html).toContain("Served");
    expect(html).toContain("Waived");
  });

  it("offers the manual record form over the division squad", () => {
    const html = render([]);
    expect(html).toContain('data-testid="record-form"');
    expect(html).toContain("K. Doe");
  });

  it("tags a report-sourced pending row with a From-match-report chip + view link", () => {
    const html = render([
      sus({ id: "rp1", status: "pending", source: "report", fixtureId: "fx1", reason: "violent conduct" }),
    ]);
    expect(html).toContain("From match report");
    expect(html).toContain("View report");
  });

  it("does not tag non-report sources", () => {
    const html = render([sus({ status: "pending", source: "auto_dismissal", fixtureId: "fx1" })]);
    expect(html).not.toContain("From match report");
  });

  // Owner-approved 4A: WHICH matches the ban covers, under the reason. 2026-11-07T15:00Z is Saturday afternoon in
  // London and already Sunday 04:00 in Auckland (NZDT, +13) — the day is the VENUE's, never the viewer's or UTC's.
  const ROUND_4 = { fixtureId: "f4", roundRole: "plain_round_4", opponentName: "Rovers", scheduledAt: "2026-11-07T15:00:00Z" };
  const NEXT_TBC = { fixtureId: null, roundRole: null, opponentName: null, scheduledAt: null };
  const line = (html: string): string | null => {
    const m = /<p[^>]*data-testid="covered-line"[^>]*>([^<]*)<\/p>/.exec(html);
    return m ? m[1]!.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : null;
  };

  it("an active ban says which match it misses: round, opponent and the venue's day", () => {
    const html = render([sus({ status: "active", coveredMatches: [ROUND_4] })]);
    expect(line(html)).toBe("Misses: Round 4 vs Rovers · Sat 7 Nov");
    // The pips stay — the line is in addition to them, not instead.
    expect(html).toContain("0 of 2 matches served");
  });

  it("reads the day in the venue zone the panel is given", () => {
    const html = render([sus({ status: "active", coveredMatches: [ROUND_4] })], "Pacific/Auckland");
    expect(line(html)).toBe("Misses: Round 4 vs Rovers · Sun 8 Nov");
  });

  it("a pending ban says what it WOULD miss — nothing is confirmed yet", () => {
    const html = render([sus({ status: "pending", coveredMatches: [ROUND_4] })]);
    expect(line(html)).toBe("Would miss: Round 4 vs Rovers · Sat 7 Nov");
    expect(html).not.toContain("Misses:");
  });

  it("several matches join with commas; an undecided opponent is TBD; placeholders fold into one counted phrase", () => {
    const semi = { fixtureId: "f5", roundRole: "semi_final", opponentName: null, scheduledAt: null };
    const html = render([sus({ status: "active", matchesTotal: 4, coveredMatches: [ROUND_4, semi, NEXT_TBC, NEXT_TBC] })]);
    expect(line(html)).toBe(
      `Misses: Round 4 vs Rovers · Sat 7 Nov, ${uiEn["bracket.round.semi"]} vs TBD, Next 2 matches (not scheduled yet)`,
    );
  });

  it("one placeholder reads in the singular", () => {
    const html = render([sus({ status: "active", matchesTotal: 1, coveredMatches: [NEXT_TBC] })]);
    expect(line(html)).toBe("Misses: Next match (not scheduled yet)");
  });

  it("nothing left to miss ⇒ no line at all (and a history row never carries one)", () => {
    expect(render([sus({ status: "active", coveredMatches: [] })])).not.toContain('data-testid="covered-line"');
    expect(render([sus({ status: "pending", coveredMatches: [] })])).not.toContain('data-testid="covered-line"');
    expect(render([sus({ status: "served", coveredMatches: [ROUND_4] })])).not.toContain('data-testid="covered-line"');
    // The positive pair: the same row with a match does render it.
    expect(render([sus({ status: "active", coveredMatches: [ROUND_4] })])).toContain('data-testid="covered-line"');
  });

  it("is translated — French reads the label, the round and the day in French", () => {
    const html = render(
      [sus({ status: "active", coveredMatches: [ROUND_4] })],
      "Europe/Paris",
      "fr",
      uiFr as unknown as Dict,
    );
    const fr = line(html);
    expect(fr?.startsWith(uiFr["disc.panel.misses"].split("{matches}")[0]!)).toBe(true);
    expect(fr).toContain(uiFr["bracket.round.plain"].replace("{n}", "4"));
    expect(fr).toContain("sam. 7 nov.");
    expect(fr).not.toContain("Misses");
  });
});
