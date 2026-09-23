// Schedule-board knockout round codes (2026-09-23, owner-approved design): a
// compact legend row explaining the codes on the cards in view. Mounted with
// renderToStaticMarkup (vitest here is `environment: "node"`), same pattern
// as fixture-block.test.tsx.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import fr from "@/dictionaries/fr/ui.json";
import { BoardRoundLegend } from "../board-legend";
import { FixtureBlock } from "../fixture-block";
import { boardRoundCodes } from "../round-codes";
import type { BoardFixture } from "../types";

const fx = (id: string, stage_id: string, round_no: number, seq_in_round: number, third_place = false): BoardFixture => ({
  id,
  stage_id,
  division_id: "d1",
  round_no,
  seq_in_round,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: null,
  court_id: null,
  status: "scheduled",
  schedule_source: "none",
  schedule_locked: false,
  outcome: null,
  ...(third_place ? { third_place: true } : {}),
});

const knockout = [
  fx("qf1", "ko", 1, 1),
  fx("qf2", "ko", 1, 2),
  fx("sf1", "ko", 2, 1),
  fx("f", "ko", 3, 1),
  fx("bronze", "ko", 3, 2, true),
];
const league = [fx("l1", "lg", 1, 1), fx("l2", "lg", 2, 1)];
const stages = [
  { id: "ko", kind: "knockout" },
  { id: "lg", kind: "league" },
];
const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

describe("BoardRoundLegend", () => {
  it("lists every code on the shown cards with its round name, in bracket order", () => {
    const codes = boardRoundCodes([...knockout, ...league], stages, en);
    const html = renderToStaticMarkup(<BoardRoundLegend fixtures={[...league, ...knockout].reverse()} tray={[]} codes={codes} />);
    expect(html).toContain('data-testid="board-legend-rounds"');
    expect(html).toContain('aria-label="Round codes"');
    // Text-only projection: tags stripped, so the order reads as a person does.
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text).toBe("QF Quarter-finals SF Semi-finals F Final 3rd Third place");
    // Design review 2026-09-23: entries are separated by GAP, never a dot.
    expect(html).not.toContain("·");
  });

  it("names only what is in view: a day holding just the semi-final lists SF alone", () => {
    const codes = boardRoundCodes(knockout, stages, en);
    const html = renderToStaticMarkup(<BoardRoundLegend fixtures={[knockout[2]!]} tray={[]} codes={codes} />);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text).toBe("SF Semi-finals");
  });

  it("the tray counts too: its codes join the day's, and a code on both lists once", () => {
    const codes = boardRoundCodes(knockout, stages, en);
    // Day holds a QF and the final; the tray holds the other QF and the bronze.
    const html = renderToStaticMarkup(
      <BoardRoundLegend fixtures={[knockout[3]!, knockout[0]!]} tray={[knockout[4]!, knockout[1]!]} codes={codes} />,
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text).toBe("QF Quarter-finals F Final 3rd Third place");
    // Tray alone (the week view, whose cards carry no chip) still gets its key.
    const trayOnly = renderToStaticMarkup(<BoardRoundLegend fixtures={[]} tray={[knockout[2]!]} codes={codes} />);
    expect(trayOnly.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("SF Semi-finals");
  });

  it("each entry leads with the SAME chip the card renders — identical class set, so the key cannot drift", () => {
    const codes = boardRoundCodes(knockout, stages, en);
    const classSet = (html: string, re: RegExp) =>
      [...new Set((re.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean))].sort();
    const legend = renderToStaticMarkup(<BoardRoundLegend fixtures={[knockout[0]!]} tray={[]} codes={codes} />);
    const card = renderToStaticMarkup(
      <FixtureBlock
        fixture={knockout[0]!}
        divisionName="Open"
        showDivision={false}
        entrantNames={{ e1: "Ash", e2: "Brook" }}
        feedLabels={{}}
        fixtureTitles={{}}
        conflicts={[]}
        canEdit
        picked={false}
        onPick={() => {}}
        onTogglePin={() => {}}
        roundCode={codes.get(knockout[0]!.id)}
      />,
    );
    const legendChip = classSet(legend, /data-round-code-chip="knockout"[^>]*class="([^"]*)"/);
    const cardChip = classSet(card, /data-testid="board-round-code"[^>]*class="([^"]*)"/);
    expect(cardChip.length).toBeGreaterThan(0);
    expect(legendChip).toEqual(cardChip);
    // …and the legend chip is not the card's testid (e2e counts cards by it).
    expect(legend).not.toContain('data-testid="board-round-code"');
  });

  it("renders NOTHING when no shown card carries a code (a round-robin board)", () => {
    const codes = boardRoundCodes([...knockout, ...league], stages, en);
    expect(renderToStaticMarkup(<BoardRoundLegend fixtures={league} tray={[]} codes={codes} />)).toBe("");
    expect(renderToStaticMarkup(<BoardRoundLegend fixtures={[]} tray={[]} codes={codes} />)).toBe("");
  });

  it("wraps rather than scrolls: a flex-wrap row with no fixed width (320px)", () => {
    const codes = boardRoundCodes(knockout, stages, en);
    const html = renderToStaticMarkup(<BoardRoundLegend fixtures={knockout} tray={[]} codes={codes} />);
    const cls = /data-testid="board-legend-rounds"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(cls.split(/\s+/)).toContain("flex-wrap");
    expect(cls).not.toMatch(/\bw-\[|\bmin-w-\[|whitespace-nowrap|overflow-x/);
  });

  it("fr: the aria label is the French dictionary's", () => {
    const frDict = fr as unknown as Dict;
    const codes = boardRoundCodes(knockout, stages, en);
    const html = renderToStaticMarkup(
      <DictProvider dict={frDict} locale="fr">
        <BoardRoundLegend fixtures={knockout} tray={[]} codes={codes} />
      </DictProvider>,
    );
    expect(html).toContain(`aria-label="${(fr as Record<string, string>)["board.roundLegend.aria"]}"`);
    expect((fr as Record<string, string>)["board.roundLegend.aria"]).not.toBe("Round codes");
  });
});
