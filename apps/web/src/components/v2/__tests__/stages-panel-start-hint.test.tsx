// Owner staging test 2026-10-19: an online (Lichess) chess division that has not been started shows nothing where the
// Open round controls will appear, and no word on why. The division page now tells the stage cards (`onlineAwaitsStart`,
// the same gates as `openRounds` plus the shared not-started predicate — online-start-hint-wiring.test.tsx is the page's
// half); this is the cards' half: one quiet line, once, in the first stage's card, for an organiser, in every locale's
// words — and nowhere else. What the Open round control itself renders is open-round-control.test.tsx's.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (id: string, seq: number) => ({ id, seq, kind: "swiss", name: `Stage ${seq}`, config: {}, progression: null, status: "active" });
const fixture = (stageId: string, no: number) => ({
  id: `f${no}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null,
});
const PROPS = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage("s1", 1), stage("s2", 2)], fixtures: [fixture("s1", 1), fixture("s2", 2)],
  entrantNames: { e1: "Alpha", e2: "Bravo" }, canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const, sportKey: "boardgame",
};
const cardOf = (h: string, stageId: string) => {
  const start = h.indexOf(`data-stage-id="${stageId}"`);
  expect(start, `stage card ${stageId}`).toBeGreaterThan(-1);
  const next = h.indexOf("data-stage-id=", start + 1);
  return h.slice(start, next === -1 ? undefined : next);
};
const HINT = 'data-testid="online-start-hint"';
const KEY = "externalPlay.openRound.startFirst";
const count = (h: string, needle: string) => h.split(needle).length - 1;

describe("the stage cards' start hint", () => {
  it("the empty case first: told nothing ⇒ no hint (the cards render)", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    expect(h).toContain('data-testid="stage-progress"');
    expect(h).not.toContain(HINT);
    expect(renderToStaticMarkup(<StagesPanel {...PROPS} onlineAwaitsStart={false} />)).not.toContain(HINT);
  });

  it("told the division has not started: ONE line, in the first stage's card, saying to start the division", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} onlineAwaitsStart openRounds={{}} />);
    expect(count(h, HINT), "once, not once per stage").toBe(1);
    expect(cardOf(h, "s1")).toContain(HINT);
    expect(cardOf(h, "s2")).not.toContain(HINT);
    // The sentence is the dictionary's, read from it (anchored on the tag's `>`, so a bare substring in a payload
    // cannot satisfy it).
    expect(h).toMatch(new RegExp(`${HINT}[^>]*>${(uiEn as Record<string, string>)[KEY]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
    expect(count(h, 'data-testid="open-round"'), "no Open round control while it waits").toBe(0);
  });

  it("the first stage is the lowest SEQ, whatever order the stages arrive in", () => {
    const h = renderToStaticMarkup(
      <StagesPanel {...PROPS} stages={[stage("s2", 2), stage("s1", 1)]} onlineAwaitsStart openRounds={{}} />,
    );
    expect(cardOf(h, "s1")).toContain(HINT);
    expect(cardOf(h, "s2")).not.toContain(HINT);
    expect(count(h, HINT)).toBe(1);
  });

  it("a viewer (no edit) is told nothing, even when the page says the division waits", () => {
    expect(renderToStaticMarkup(<StagesPanel {...PROPS} canEdit={false} onlineAwaitsStart />)).not.toContain(HINT);
  });

  it("a division with no stage yet has no card to put it in — and does not crash", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} stages={[]} fixtures={[]} onlineAwaitsStart />);
    expect(h).not.toContain(HINT);
  });

  it("the sentence exists in all four locales, each in its own words", () => {
    const dicts = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts)) {
      expect(typeof dict[KEY] === "string" && dict[KEY]!.trim().length > 0, `${locale} ${KEY}`).toBe(true);
      if (locale !== "en") expect(dict[KEY], `${locale} is translated`).not.toBe(dicts.en![KEY]);
      checked++;
    }
    expect(checked).toBe(4);
    expect(new Set(Object.values(dicts).map((d) => d[KEY])).size).toBe(4);
  });
});
