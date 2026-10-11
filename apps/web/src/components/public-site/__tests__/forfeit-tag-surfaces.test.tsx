// W2b Task 13 (spec §5.5, UI-2 option A) — each surface that calls `forfeitTag` puts its tag and sentence where it
// says it does: the hub's results card, the hub's draw node, the public bracket tile, the live score's fallback line
// and the organiser's run-sheet result line. `apps/web` vitest is `environment: "node"`, so these are rendered markup
// (what the browser receives); `e2e/walkover-public.spec.ts` drives the same surfaces in a browser at 320/768/1280.
//
// The forfeit outcomes are the engine's shape for each of its reasons (`FORFEIT_REASONS`; forfeit-tag.test.ts folds
// them through real modules); the words are the real public.json / ui.json, never typed here except UI-2's tags.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { FORFEIT_REASONS } from "@seazn/engine/core";
import en from "@/dictionaries/en/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { msg } from "@/lib/messages";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { getDictionary } from "@/lib/i18n";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import type { PublicFixture } from "@/server/public-site/data";
import { hubForfeit } from "@/server/public-site/competition-hub";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { MatchCard } from "../matches-hub/match-card";
import { Bracket } from "../bracket";
import { LiveScoreBody } from "../live-score";
import { outcomeText } from "@/components/v2/stages-panel";
import { resolveSlotLabel } from "@/lib/slot-label";

const DICT = en as unknown as Dict;
const UI = uiEn as Record<string, string>;
const tr = (key: string, vars?: Record<string, string | number>) => t(DICT, key, vars);
const NAMES: Record<string, string> = { h: "Riverside FC", a: "Harbour United", b: "Bears", c: "Cats" };
const award = (reason: string, winner = "h", loser = "a") => ({ kind: "award", winner, loser, reason });
const TAG: Record<string, string> = { walkover: "w/o", withdrew: "w/o", retired: "ret.", disqualified: "DQ" };

/** Escape for a search inside rendered markup: React writes `'` as `&#x27;`. */
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

function fixture(over: Partial<PublicFixture>): PublicFixture {
  return {
    id: "f1", division_id: "d", stage_id: "s", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: "h", away_entrant_id: "a", home_slot_label: null, away_slot_label: null, scheduled_at: null,
    venue: null, court_label: null, venue_name: null, court_name: null, status: "forfeited", outcome: null,
    summary: { headline: "3–0", perSide: [{ entrantId: "h", line: "3" }, { entrantId: "a", line: "0" }] }, last_seq: 1,
    ...over,
  } as PublicFixture;
}

const ctx = (fixtures: PublicFixture[] = [], resultSentence: () => string | null = () => null) => ({
  byId: new Map(fixtures.map((f) => [f.id, f])),
  names: NAMES,
  msg: tr,
  resultSentence,
});

describe("hubForfeit — the hub card's words (the producer)", () => {
  it("empty case first: a played result and a bye carry none", () => {
    expect(hubForfeit(fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } }), ctx())).toBeNull();
    expect(hubForfeit(fixture({ away_entrant_id: null, outcome: { kind: "award", winner: "h", loser: null, reason: "bye" } as never }), ctx())).toBeNull();
    expect(hubForfeit(fixture({ outcome: null }), ctx())).toBeNull();
  });

  it("X-RS-2: every reason, its tag and a sentence naming the side that did not play on", () => {
    let rows = 0;
    for (const reason of FORFEIT_REASONS) {
      const w = hubForfeit(fixture({ outcome: award(reason) as never }), ctx())!;
      expect(w.tag, reason).toBe(TAG[reason]);
      expect(w.kind).toBe(reason);
      expect(w.sentence, reason).toContain("Harbour United");
      expect(w.sentence, reason).not.toContain("Riverside FC");
      rows++;
    }
    expect(rows).toBe(4);
  });

  it("X-DW-1: the next-round clause comes from the division's own next fixture, and only when the line feeds it", () => {
    const next = fixture({ id: "fin", home_entrant_id: "b", away_entrant_id: null, outcome: award("walkover", "b", null as never) as never });
    const dw = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: "fin", loser_to_fixture: null });
    expect(hubForfeit(dw, ctx([dw, next]))!.sentence).toBe("Neither side showed up — both lose. Next round: walkover for Bears.");
    // A final (feeds nothing): no clause. A next match still waiting: no clause.
    const final = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: null, loser_to_fixture: null });
    expect(hubForfeit(final, ctx([final]))!.sentence).toBe("Neither side showed up — both lose.");
    const waiting = fixture({ id: "fin", outcome: null, status: "scheduled" });
    expect(hubForfeit(dw, ctx([dw, waiting]))!.sentence).toBe("Neither side showed up — both lose.");
    // D19 (`feedsNextMatch`): a line whose winner AND loser both go to the same match (a two-entrant double elim's
    // winners' match into the grand final) feeds no NEXT match — even with that match walked over, no clause.
    const both = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: "fin", loser_to_fixture: "fin" });
    expect(hubForfeit(both, ctx([both, next]))!.sentence).toBe("Neither side showed up — both lose.");
  });

  it("X-AB-2: an abandon's words read the ledger column, and carry the card's own result sentence", () => {
    const dls = fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a", method: "dls" } });
    expect(hubForfeit(dls, ctx()), "no abandon in the ledger: a played DLS result").toBeNull();
    const w = hubForfeit({ ...dls, abandon_reason: "rain" }, ctx([], () => "Riverside FC won by 12 runs (DLS)"))!;
    expect(w.tag).toBe("Aband. · DLS");
    expect(w.sentence).toBe("Abandoned (rain) — Riverside FC won by 12 runs (DLS).");
  });
});

// ---------------------------------------------------------------- the results card

function header(over: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: false, status: "other",
    sides: [
      { entrantId: "h", name: "Riverside FC", short: "RIV", colour: null, badgeUrl: null },
      { entrantId: "a", name: "Harbour United", short: "HAR", colour: null, badgeUrl: null },
    ],
    scoreLines: ["3", "0"], subLines: [null, null], battingIndex: null,
    statusLine: { key: "matchCentre.status.forfeited" }, rateLine: null, phase: null, strength: null, pillNote: null,
    metaLine: null, updatedAt: "2026-10-09T12:00:00.000Z", ...over,
  };
}
function hubMatch(over: Partial<HubMatchT> = {}): HubMatchT {
  return {
    fixtureId: "f1", divisionId: "d1", divisionSlug: "d", divisionName: "Division", sportKey: "football",
    stageName: "Cup", roundNo: 1, roundLabel: null, bucket: "completed", tz: "UTC", scheduledAt: null,
    venueName: null, courtName: null, href: "/x/f1", header: header(), winnerIndex: 0, resultLine: null, ...over,
  };
}
const card = (m: HubMatchT) => renderToStaticMarkup(createElement(MatchCard, { match: m, dict: DICT, locale: "en", now: 0 }));

describe("MatchCard — the results list (the consumer)", () => {
  it("empty case first: no forfeit, no tag — the status line reads as before", () => {
    const h = card(hubMatch());
    expect(h).not.toContain('role="img"');
    expect(h).toContain(">Forfeited<");
    expect(h).not.toContain("aria-describedby");
  });

  it("the tag is shown, its accessible name and tooltip are the sentence, and the card is described by it", () => {
    const sentence = "Harbour United didn't show up — walkover.";
    const h = card(hubMatch({ forfeit: { kind: "walkover", tag: "w/o", sentence } }));
    expect(h).toContain(`role="img" aria-label="${html(sentence)}" title="${html(sentence)}"`);
    expect(h).toMatch(/data-testid="mh-match-forfeit-tag"[^>]*>w\/o<\/span>/);
    expect(h).toContain('aria-describedby="mh-forfeit-f1"');
    expect(h).toContain('id="mh-forfeit-f1"');
    expect(h, "the tag replaces the bare status word").not.toContain(">Forfeited<");
  });

  it("an abandon keeps its result sentence beside the tag", () => {
    const h = card(hubMatch({ resultLine: "Riverside FC won by 12 runs (DLS)", forfeit: { kind: "abandoned_dls", tag: "Aband. · DLS", sentence: "S" } }));
    const slot = h.slice(h.indexOf('data-testid="mh-match-forfeit"'));
    expect(slot).toContain("Riverside FC won by 12 runs (DLS)");
    expect(slot).toContain(">Aband. · DLS<");
  });
});

// ---------------------------------------------------------------- the bracket tile

describe("Bracket — the tile at every width has ONE footer row (the consumer)", () => {
  const boardText = (_stageId: string, label: never) => resolveSlotLabel(label, msg, "schedule.tbd");
  const render = async (fixtures: PublicFixture[], withForfeit = true) => {
    const dict = await getDictionary("en", "public");
    const copy = publicScheduleCopy(dict, msg);
    return renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout", fixtures, entrantNames: NAMES, fixtureHref: (id: string) => `/f/${id}`, lookup: msg,
        slotText: boardText, copy: withForfeit ? { ...copy, forfeit: forfeitCopyOf((k) => t(dict, k)) } : copy,
        tz: "UTC", locale: "en",
      }),
    );
  };
  const two = (semi: Partial<PublicFixture>) => [
    fixture({ id: "s1", round_no: 0, seq_in_round: 1, winner_to_fixture: "fin", winner_to_slot: 0, ...semi }),
    fixture({ id: "s2", round_no: 0, seq_in_round: 2, home_entrant_id: "b", away_entrant_id: "c", status: "decided", outcome: { kind: "win", winner: "b", loser: "c" }, winner_to_fixture: "fin", winner_to_slot: 1 }),
    fixture({ id: "fin", round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: "b", status: "scheduled", outcome: null, summary: null }),
  ];

  it("the forfeit tile shows the credited score and the tag on one row; the sentence is the tag's name", async () => {
    const h = await render(two({ outcome: award("withdrew") as never }));
    const row = h.slice(h.indexOf('data-testid="bracket-forfeit"'), h.indexOf('data-testid="bracket-forfeit"') + 900);
    expect(row).toContain("3–0");
    expect(row).toContain(">w/o<");
    expect(row).toContain(`aria-label="${html("Harbour United withdrew — walkover.")}"`);
    expect(h.match(/data-testid="bracket-forfeit-tag"/g)?.length, "only the forfeited tile").toBe(1);
  });

  it("X-DW-1 on a tile: the double walkover names the next round's walkover once the final stands walked over", async () => {
    const fx = two({ outcome: { kind: "double_walkover" } as never });
    fx[2] = { ...fx[2]!, status: "forfeited", outcome: award("walkover", "b", null as never) as never };
    const h = await render(fx);
    expect(h).toContain(`aria-label="${html("Neither side showed up — both lose. Next round: walkover for Bears.")}"`);
    expect(h).toContain(">2× w/o<");
  });

  it("the positive pair: a caller that hands no forfeit copy shows no tag (the old footer)", async () => {
    const h = await render(two({ outcome: award("walkover") as never }), false);
    expect(h).not.toContain("bracket-forfeit");
    expect(h).toContain("3–0");
  });
});

// ---------------------------------------------------------------- the live score

describe("LiveScoreBody — the fallback line (no document)", () => {
  const templates = { tie: "", plain: "{winner} won", shootoutPlain: "", byMethod: {} };
  it("a forfeit reads its sentence, not the bare winner line; a played win keeps its own", () => {
    const forfeit = renderToStaticMarkup(
      createElement(LiveScoreBody, {
        data: { status: "forfeited", summary: { headline: "3 – 0" }, outcome: award("retired") },
        entrantNames: NAMES, sportKey: "tennis", decidedTemplates: templates, dict: DICT,
      }),
    );
    expect(forfeit).toContain("Harbour United retired.");
    const played = renderToStaticMarkup(
      createElement(LiveScoreBody, {
        data: { status: "decided", summary: { headline: "2 – 1" }, outcome: { kind: "win", winner: "h", loser: "a" } },
        entrantNames: NAMES, sportKey: "tennis", decidedTemplates: templates, dict: DICT,
      }),
    );
    expect(played).toContain("Riverside FC won");
    expect(played).not.toContain("retired");
  });
});

// ---------------------------------------------------------------- the organiser's run sheet

describe("outcomeText — the division result line (stages-panel, read by the run sheet)", () => {
  const ui = (key: string, vars?: Record<string, string | number>) => msg(key as never, vars);
  it("empty case first: no outcome is no line; a played win reads as before", () => {
    expect(outcomeText(ui, null, NAMES)).toBeNull();
    expect(outcomeText(ui, { kind: "win", winner: "h" }, NAMES)).toBe("Riverside FC won");
  });
  it("each forfeit reason carries its tag; a double walkover reads its tag (it read nothing before); a bye keeps today's copy", () => {
    let rows = 0;
    for (const reason of FORFEIT_REASONS) {
      expect(outcomeText(ui, award(reason), NAMES), reason).toBe(`Riverside FC won (${TAG[reason]})`);
      rows++;
    }
    expect(rows).toBe(4);
    expect(outcomeText(ui, { kind: "double_walkover" }, NAMES)).toBe(UI["forfeit.tag.doubleWalkover"]);
    expect(outcomeText(ui, { kind: "award", winner: "h", loser: null, reason: "bye" }, NAMES)).toBe(
      UI["schedule.outcome.wonWo"]!.replace("{name}", "Riverside FC"),
    );
  });
  it("X-AB-2: an abandon's tag reads the row's ledger — none without it", () => {
    const dls = { kind: "win", winner: "h", loser: "a", method: "dls" };
    expect(outcomeText(ui, dls, NAMES)).toBe("Riverside FC won");
    expect(outcomeText(ui, dls, NAMES, { abandon: { reason: "rain" } })).toBe("Riverside FC won (Aband. · DLS)");
    expect(outcomeText(ui, { kind: "no_result" }, NAMES, { abandon: { reason: "rain" } })).toBe(
      `${UI["schedule.outcome.noResult"]} · ${UI["forfeit.tag.abandonedNoResult"]}`,
    );
  });
});
